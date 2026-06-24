/**
 * stream.ts — stream dispatch with routing + failover + latency measurement
 *
 * Self-contained OpenAI-compatible SSE client. No dependency on pi-ai internals
 * beyond the AssistantMessageEventStream type (imported from @mariozechner/pi-ai).
 *
 * The streamSimple function signature is:
 *   (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream
 *
 * It returns an AssistantMessageEventStream (not a Promise/callback). Events are
 * pushed via .push() and the stream is terminated with .end(result).
 *
 * Flow:
 * 1. Extract prompt prefix from context.messages
 * 2. Select a backend via the router (cache-affinity ring by default)
 * 3. POST /v1/chat/completions with stream:true to the selected backend
 * 4. Parse SSE chunks, push AssistantMessageEvent objects into the stream
 * 5. Measure TTFT (time to first token) and record it for latency routing
 * 6. On connection error before any output, failover to the next backend
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { PoolConfig, Pool } from "./config.js";
import type { StateStore } from "./state.js";
import { Router } from "./router.js";

// ─── Prompt prefix extraction ────────────────────────────────────────────────

function extractPromptPrefix(messages: Message[], systemPrompt?: string): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(systemPrompt);
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? msg.content
        : msg.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("");
      if (content) parts.push(content);
    }
    if (parts.length >= 2) break;
  }
  return parts.join("\n\n");
}

// ─── Message conversion (pi-ai → OpenAI format) ──────────────────────────────

function toOpenAIMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map((msg) => {
    if (msg.role === "toolResult") {
      return {
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content.map((c) => c.type === "text" ? c.text : "").join(""),
      };
    }
    const content = typeof msg.content === "string"
      ? msg.content
      : msg.content.map((c) => {
          if (c.type === "text") return { type: "text", text: c.text };
          if (c.type === "thinking") return { type: "thinking", thinking: c.thinking };
          return null;
        }).filter(Boolean);

    return { role: msg.role, content } as Record<string, unknown>;
  });
}

// ─── Partial AssistantMessage factory ────────────────────────────────────────

function makePartial(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

// ─── SSE parsing state ───────────────────────────────────────────────────────

interface ParseState {
  started: boolean;
  contentIndex: number;
  inText: boolean;
  inThinking: boolean;
  textBuffer: string;
  thinkingBuffer: string;
  partial: AssistantMessage;
}

function makeParseState(model: Model<Api>): ParseState {
  return {
    started: false,
    contentIndex: 0,
    inText: false,
    inThinking: false,
    textBuffer: "",
    thinkingBuffer: "",
    partial: makePartial(model),
  };
}

// ─── Tool call tracking for delta correlation ─────────────────────────────────

interface ToolCallTracker {
  id: string;
  argsBuffer: string;
}

/**
 * Parse one SSE data line and push events to the stream.
 * Returns true if the stream is complete ([DONE] or finish_reason).
 */
function parseSseLine(
  line: string,
  stream: AssistantMessageEventStream,
  state: ParseState,
  toolTrackers: Map<number, ToolCallTracker>,
): boolean {
  if (!line.startsWith("data: ")) return false;
  const data = line.slice(6);
  if (data === "[DONE]") {
    closeOpenBlocks(stream, state);
    stream.push({ type: "done", reason: "stop", message: state.partial });
    stream.end(state.partial);
    return true;
  }

  try {
    const json = JSON.parse(data);
    const choice = json.choices?.[0];
    if (!choice) return false;

    if (!state.started) {
      state.started = true;
      stream.push({ type: "start", partial: state.partial });
    }

    const delta = choice.delta ?? {};

    // Reasoning/thinking content (DeepSeek, Kimi, GLM)
    const reasoning: string | undefined = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) {
      if (!state.inThinking) {
        if (state.inText) closeText(stream, state);
        state.inThinking = true;
        state.partial.content.push({ type: "thinking", thinking: "" });
        stream.push({ type: "thinking_start", contentIndex: state.contentIndex, partial: state.partial });
        state.contentIndex++;
      }
      state.thinkingBuffer += reasoning;
      const tc = state.partial.content[state.contentIndex - 1] as ThinkingContent;
      tc.thinking = state.thinkingBuffer;
      stream.push({ type: "thinking_delta", contentIndex: state.contentIndex - 1, delta: reasoning, partial: state.partial });
    }

    // Regular text content
    const content: string | undefined = delta.content;
    if (content) {
      if (!state.inText) {
        if (state.inThinking) closeThinking(stream, state);
        state.inText = true;
        state.partial.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: state.contentIndex, partial: state.partial });
        state.contentIndex++;
      }
      state.textBuffer += content;
      const tc = state.partial.content[state.contentIndex - 1] as TextContent;
      tc.text = state.textBuffer;
      stream.push({ type: "text_delta", contentIndex: state.contentIndex - 1, delta: content, partial: state.partial });
    }

    // Tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx: number = tc.index ?? 0;
        if (tc.function?.name) {
          if (state.inText) closeText(stream, state);
          if (state.inThinking) closeThinking(stream, state);
          const id = tc.id ?? `call_${state.contentIndex}`;
          const toolCall: ToolCall = { type: "toolCall", id, name: tc.function.name, arguments: {} };
          state.partial.content.push(toolCall);
          toolTrackers.set(idx, { id, argsBuffer: "" });
          stream.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: state.partial });
          state.contentIndex++;
        }
        if (tc.function?.arguments) {
          const tracker = toolTrackers.get(idx);
          if (!tracker) continue;
          tracker.argsBuffer += tc.function.arguments;
          const toolCall = state.partial.content[state.contentIndex - 1] as ToolCall;
          try {
            toolCall.arguments = JSON.parse(tracker.argsBuffer);
          } catch { /* partial JSON — keep accumulating */ }
          stream.push({ type: "toolcall_delta", contentIndex: state.contentIndex - 1, delta: tc.function.arguments, partial: state.partial });
        }
      }
    }

    // Finish reason
    if (choice.finish_reason) {
      closeOpenBlocks(stream, state);
      const reason = choice.finish_reason === "length" ? "length" as const
        : choice.finish_reason === "tool_calls" ? "toolUse" as const
        : "stop" as const;
      state.partial.stopReason = reason;
      stream.push({ type: "done", reason, message: state.partial });
      stream.end(state.partial);
      return true;
    }

    // Usage (if present in stream)
    if (json.usage) {
      const u = json.usage;
      state.partial.usage = {
        input: u.prompt_tokens ?? 0,
        output: u.completion_tokens ?? 0,
        cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWrite: 0,
        totalTokens: u.total_tokens ?? 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    }

    return false;
  } catch {
    return false;
  }
}

function closeText(stream: AssistantMessageEventStream, state: ParseState): void {
  if (!state.inText) return;
  stream.push({ type: "text_end", contentIndex: state.contentIndex - 1, content: state.textBuffer, partial: state.partial });
  state.inText = false;
  state.textBuffer = "";
}

function closeThinking(stream: AssistantMessageEventStream, state: ParseState): void {
  if (!state.inThinking) return;
  stream.push({ type: "thinking_end", contentIndex: state.contentIndex - 1, content: state.thinkingBuffer, partial: state.partial });
  state.inThinking = false;
  state.thinkingBuffer = "";
}

function closeOpenBlocks(stream: AssistantMessageEventStream, state: ParseState): void {
  closeText(stream, state);
  closeThinking(stream, state);
}

// ─── Backend dispatch ────────────────────────────────────────────────────────

async function dispatchToBackend(
  baseUrl: string,
  apiKey: string,
  headers: Record<string, string> | undefined,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  onFirstEvent: () => void,
): Promise<boolean> {
  const url = baseUrl.replace(/\/v1\/?$/, "") + "/v1/chat/completions";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Backend ${baseUrl} returned ${res.status}: ${errText}`);
  }

  if (!res.body) throw new Error(`Backend ${baseUrl} returned no body`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const state = makeParseState(model);
  const toolTrackers = new Map<number, ToolCallTracker>();
  let firstEvent = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!firstEvent) {
          firstEvent = true;
          onFirstEvent();
        }
        if (parseSseLine(trimmed, stream, state, toolTrackers)) return true;
      }
    }
    if (buffer.trim()) {
      if (!firstEvent) {
        firstEvent = true;
        onFirstEvent();
      }
      parseSseLine(buffer.trim(), stream, state, toolTrackers);
    }
    // If we didn't get a [DONE], close the stream anyway
    closeOpenBlocks(stream, state);
    stream.push({ type: "done", reason: "stop", message: state.partial });
    stream.end(state.partial);
    return true;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

// ─── Stream handler factory ──────────────────────────────────────────────────

export function createStreamHandler(
  pools: PoolConfig,
  state: StateStore,
  router: Router,
) {
  const poolMap = new Map<string, Pool>();
  for (const p of pools.pools) {
    poolMap.set(p.public_model, p);
  }

  return function streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();

    // Find the pool by model id
    const modelId = model.id;
    let pool: Pool | undefined = poolMap.get(`pooled/${modelId}`) ?? poolMap.get(modelId);
    if (!pool) {
      for (const [key, p] of poolMap) {
        if (key.endsWith(`/${modelId}`)) {
          pool = p;
          break;
        }
      }
    }
    if (!pool) {
      const errPartial = makePartial(model);
      errPartial.stopReason = "error";
      errPartial.errorMessage = `No pool found for model: ${modelId}`;
      stream.push({ type: "error", reason: "error", error: errPartial });
      stream.end(errPartial);
      return stream;
    }

    const promptPrefix = extractPromptPrefix(context.messages, context.systemPrompt);

    // Build request body
    const messages = toOpenAIMessages(context.messages);
    if (context.systemPrompt) {
      messages.unshift({ role: "system", content: context.systemPrompt });
    }
    const body: Record<string, unknown> = { messages, stream: true };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options?.reasoning) {
      body.reasoning_effort = options.reasoning === "xhigh" ? "max" : options.reasoning;
    }

    // ── Failover loop (async, pushes into stream) ──
    // Track whether any event was pushed — used for failover decision
    let streamFinalized = false;

    (async () => {
      const maxAttempts = pool!.members.length;
      const tried = new Set<string>();
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const selection = router.select(pool!, promptPrefix);
        if (!selection) break;

        const { backendKey, backend } = selection;
        if (tried.has(backendKey)) continue;
        tried.add(backendKey);

        const member = backend.member;
        state.acquire(backendKey);

        let firstEventReceived = false;
        const startTime = Date.now();

        try {
          const backendBody = { ...body, model: member.model ?? modelId };
          const completed = await dispatchToBackend(
            member.baseUrl,
            member.apiKey,
            member.headers,
            backendBody,
            options?.signal,
            stream,
            model,
            () => {
              firstEventReceived = true;
              const ttft = Date.now() - startTime;
              state.recordSuccess(backendKey, ttft);
            },
          );

          state.release(backendKey);
          if (completed) {
            streamFinalized = true;
            return;
          }
        } catch (err) {
          state.release(backendKey);
          state.recordFailure(backendKey);

          const errMsg = err instanceof Error ? err.message : String(err);
          lastError = err instanceof Error ? err : new Error(errMsg);
          console.warn(`[pool-router] Backend ${member.id} failed, trying next`, {
            pool: pool!.public_model,
            backend: member.id,
            error: errMsg,
            attempt: attempt + 1,
          });

          // Only failover if no events were pushed yet
          if (firstEventReceived) break;
          continue;
        }
      }

      // All backends exhausted or error after partial output
      if (!streamFinalized) {
        const errorPartial = makePartial(model);
        errorPartial.stopReason = "error";
        errorPartial.errorMessage = lastError?.message ?? "All backends exhausted";
        stream.push({ type: "error", reason: "error", error: errorPartial });
        stream.end(errorPartial);
        streamFinalized = true;
      }
    })();

    return stream;
  };
}
