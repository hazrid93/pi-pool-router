/**
 * index.ts — extension entry point
 *
 * Registers a single custom LLM provider named "pooled" via pi.registerProvider.
 * All pool models are registered under this one provider. The custom streamSimple
 * function routes requests to the correct pool based on the model id, then selects
 * a backend using the cache-affinity hash ring strategy.
 *
 * On omp, the onLoad hook rewrites "@mariozechner/pi-coding-agent" → "@oh-my-pi/pi-coding-agent".
 * On pi-mono, the import resolves natively. Either way, the ExtensionAPI is the same.
 */

import type { ExtensionAPI, ProviderConfig } from "@mariozechner/pi-coding-agent";
import { loadConfig, type PoolConfig, type Pool } from "./config.js";
import { StateStore } from "./state.js";
import { Router } from "./router.js";
import { HealthChecker } from "./health.js";
import { createStreamHandler } from "./stream.js";

export default function poolRouter(pi: ExtensionAPI): void {
  let config: PoolConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pool-router] Failed to load pools.json — ${msg}`);
    return;
  }

  // Initialize state and router
  const state = new StateStore();
  for (const pool of config.pools) {
    state.registerPool(pool);
  }
  const router = new Router(state);

  // Create the custom stream handler — returns the streamSimple function
  const streamSimple = createStreamHandler(config, state, router);

  // Start the background health checker
  const health = new HealthChecker(state);
  health.start();

  // Register ONE provider with all pool models.
  // Each pool's public_model is "pooled/<modelId>" — the provider name is "pooled"
  // and the model ids are the bare model names (e.g. "glm-5.2", "kimi-k2.7").
  const allModels = config.pools.flatMap((pool: Pool) => {
    const modelId = pool.public_model.split("/")[1];
    const firstMember = pool.members[0];
    return [{
      id: modelId,
      name: modelId,
      reasoning: firstMember.reasoning ?? false,
      input: firstMember.input ?? ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: firstMember.contextWindow ?? 128000,
      maxTokens: firstMember.maxTokens ?? 16384,
    }];
  });

  // ProviderConfig.streamSimple expects (model: Model<Api>, context: Context, options?) => AssistantMessageEventStream.
  // Our function matches this — the cast through unknown bridges the Api generic parameter.
  const providerConfig: ProviderConfig = {
    api: "pool-dispatch",
    baseUrl: "http://pool-router.local",
    apiKey: "pool-router-local",
    streamSimple: streamSimple as unknown as NonNullable<ProviderConfig["streamSimple"]>,
    models: allModels,
  };

  pi.registerProvider("pooled", providerConfig);

  console.log(`[pool-router] Registered ${config.pools.length} pool(s), ${allModels.length} model(s)`, {
    pools: config.pools.map((p) => ({ model: p.public_model, strategy: p.strategy, members: p.members.length })),
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  pi.on("session_start", async () => {
    console.debug("[pool-router] session started");
  });

  pi.on("session_shutdown", async () => {
    health.stop();
    console.debug("[pool-router] health checker stopped");
  });
  // ── /pool-status slash command ─────────────────────────────────────────────
  // handler receives args as a single string (not string[]), per the RegisteredCommand type
  pi.registerCommand("pool-status", {
    description: "Show pool router backend status (health, latency, request counts)",
    handler: async (_args: string, ctx) => {
      const backends = state.getAllStates();
      const lines: string[] = ["Pool Router Status", "─────────────────────"];

      // Group by pool
      const byPool = new Map<string, typeof backends>();
      for (const b of backends) {
        const arr = byPool.get(b.pool.public_model) ?? [];
        arr.push(b);
        byPool.set(b.pool.public_model, arr);
      }

      for (const [poolModel, members] of byPool) {
        lines.push(`\nPool: ${poolModel}`);
        lines.push(`  Strategy: ${members[0].pool.strategy}`);
        lines.push("  Backends:");
        for (const b of members) {
          const status = b.health === "healthy" ? "✓" : b.health === "cooldown" ? "⏳" : "✗";
          lines.push(
            `    ${status} ${b.member.id.padEnd(16)} ` +
            `lat=${b.ewmaLatencyMs.toFixed(0).padStart(4)}ms ` +
            `inflight=${b.inFlight} ` +
            `reqs=${b.totalRequests} ` +
            `errs=${b.totalErrors}`
          );
        }
      }

      if (ctx.hasUI) {
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        // Non-interactive mode (print/RPC) — log to stdout
        console.log(lines.join("\n"));
      }
    },
  });
}
