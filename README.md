# Pool Router


📎 **[Architecture & Sequence Diagrams](docs/architecture.md)**

📖 **[DeepWiki](https://app.devin.ai/org/isaiya-9bf81eafd4d3/wiki/hazrid93/pi-pool-router?branch=main)**

A pi/omp in-process extension that replaces LiteLLM's pool routing natively. Define pools in a self-contained `pools.json` — the extension registers a custom provider that routes requests across backends using a **cache-affinity hash ring** with a latency pre-filter.

## Why cache-affinity?

Most load balancers spread traffic by time — "don't send to the same backend you just used." But the backend you just used is the one with your prompt prefix **already cached**. Penalizing it forces a cold backend to re-process 100k+ tokens — a 30s+ TTFT penalty that dwarfs any latency difference.

Cache-affinity spreads by **content**, not time:
- **Same prompt** → same hash → same backend → prefix cache stays warm
- **Different prompts** → different hashes → different backends → natural spread
- No tension between cache-friendliness and anti-affinity — they're the same axis

## How the hash ring works

The ring is a **sorted array** of backend hash positions. "Walking clockwise" means taking the next bigger hash in the sorted list.

```
                    ┌─────────────────────────────┐
                    │     Sorted hash ring         │
                    │  (150 virtual nodes/backend)  │
                    └─────────────────────────────┘

     hash 0                                              hash MAX
      │                                                      │
      ▼                                                      ▼
      ┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
      │ A₁ │ B₁ │ A₂ │ C₁ │ B₂ │ A₃ │ C₂ │ B₃ │ A₄ │ C₃ │  ...
      └────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘
                    ▲                          ▲
                    │                          │
              prompt hash              first node ≥ hash
              (sha256 of              → backend A (walk
               prefix[:4096])            clockwise from here)
```

A = backend 1, B = backend 2, C = backend 3. Same prompt → same hash → same position → same backend. If that backend is saturated or in cooldown, walk clockwise to the next.

### Building the ring

Each backend is hashed to multiple positions (virtual nodes) for even distribution:

```
sha256("makora-1#0")  = position A
sha256("makora-1#1")  = position B
...
sha256("makora-1#149")= position C     ← 150 virtual nodes per backend
sha256("makora-2#0")  = position D
...
```

All positions are sorted into one array. That's the ring.

### Selecting a backend

1. Hash the prompt prefix: `sha256("Summarize this code..."[:4096])` → a number
2. **Binary search** the sorted array for the first position ≥ the prompt hash
3. If none is ≥ the prompt hash, **wrap around** to index 0 (the ring is circular)
4. Skip backends that are saturated (at max in-flight) or in cooldown — keep walking

### Binary search: why `lo = mid + 1`?

We're finding the leftmost element ≥ target. Two cases:

- `nodes[mid].hash < target` → mid is **proven too small**, exclude it: `lo = mid + 1`
- `nodes[mid].hash >= target` → mid **might be the answer**, keep it: `hi = mid`

Without the `+1`, when `lo` and `hi` are adjacent, `mid` keeps computing to `lo` and the search space never shrinks — infinite loop. The `+1` is the act of throwing away a proven-wrong index.

### Why "consistent"?

When a backend goes down, only **its prompts** re-map — the rest stay put. Compare:

| | `hash % N` (naive) | Consistent hashing |
|---|---|---|
| Remove 1 of 3 backends | ~67% of prompts re-map | ~33% re-map (only the dead backend's) |
| Add a backend back | Everything re-maps again | Only that backend's prompts return |

This is what memcached, Dynamo, and Cassandra use for the same problem.

## Latency pre-filter

Before the ring runs, backends are filtered by latency:

1. Find the lowest EWMA latency among eligible backends
2. Keep only those within `latency_buffer` (default 10%) of the best
3. Build the ring from survivors only

This excludes slow/degraded backends from the ring while preserving cache locality among the fast ones.

## Strategies

| Strategy | Default | Description |
|---|---|---|
| `cache-affinity` | ✅ | Consistent hash ring on prompt prefix + latency pre-filter |
| `round-robin` | | Rotate through eligible backends |

## Setup

### 1. Create `pools.json`

Place at `~/.pi/pools.json` (pi) or `~/.omp/agent/pools.json` (omp):

> **Host-aware loading.** The extension auto-detects whether it's running under pi
> or omp (via the `PI_CODING_AGENT` env var and the installed dependency layout)
> and loads config from the *current host's* path first. An empty or stray file
> under the *other* host's dir is skipped with a warning and never shadows a
> valid config. You can also place a `pools.json` in your project's cwd as a
> manual override (checked last).

```json
{
  "pools": [
    {
      "public_model": "pooled/glm-5.2",
      "strategy": "cache-affinity",
      "strategy_args": {
        "latency_buffer": 0.1,
        "hash_prefix_chars": 4096,
        "max_in_flight_per_backend": 3
      },
      "members": [
        {
          "id": "neuralwatt",
          "baseUrl": "https://api.neuralwatt.com/v1",
          "apiKey": "sk-xxx",
          "api": "openai-completions",
          "model": "glm-5.2-short",
          "contextWindow": 131072,
          "maxTokens": 16384,
          "reasoning": true
        },
        {
          "id": "getlilac",
          "baseUrl": "https://api.getlilac.com/v1",
          "apiKey": "lilac_sk-xxx",
          "api": "openai-completions",
          "model": "zai-org/glm-5.2",
          "contextWindow": 131072,
          "maxTokens": 16384,
          "reasoning": true
        },
        {
          "id": "synthetic",
          "baseUrl": "https://api.synthetic.new/openai/v1",
          "apiKey": "syn_xxx",
          "api": "openai-completions",
          "model": "hf:zai-org/GLM-5.2",
          "contextWindow": 131072,
          "maxTokens": 16384,
          "reasoning": true
        }
      ]
    }
  ]
}
```

All entries with the same `public_model` are merged into one pool. Each member has its API key inline — no reference to `models.yml`.

### 2. Install the extension

**From GitHub (omp):**
```bash
omp plugin install github:hazrid93/pi-pool-router
```

**From GitHub (pi):**
```bash
pi install https://github.com/hazrid93/pi-pool-router
```

**Local dev (omp):**
```bash
omp plugin link ./path/to/pi-pool-router
```

> Marketplace installs do NOT load extension modules — use `github:` spec (omp), `https://` URL (pi), or `plugin link` (omp local dev).

### 3. Configure the default model

**omp** (`~/.omp/agent/config.yml`):

```yaml
modelRoles:
  default: pooled/glm-5.2:xhigh
  vision: pooled/glm-5.2:off
  advisor: pooled/glm-5.2:xhigh
  plan: pooled/glm-5.2:xhigh
```

Also remove the old provider block from `~/.omp/agent/models.yml` — the extension registers `pooled` as a provider automatically.

**pi** (`~/.pi/agent/settings.json`):

The `pi install` command already adds the extension to `packages`. Set the default model by adding two keys:
```json
{
  "packages": [
    "https://github.com/hazrid93/pi-pool-router"
  ],
  "defaultProvider": "pooled",
  "defaultModel": "glm-5.2",
  "defaultThinkingLevel": "xhigh"
}
```

Alternatively, pass `--model pooled/glm-5.2` on each invocation. pi does **not** support `modelRoles`, `advisor`, or `config.yml` — those are omp-only.

### 4. PATH setup for pi

pi is a Node.js application and requires `node` on PATH. If using nvm, ensure the node bin directory is in PATH:
```bash
export PATH="$HOME/.nvm/versions/node/v22.23.0/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
```
Add this to your shell profile (`~/.bashrc` or `~/.zshrc`) for persistence.

### 5. Verify

Run `/pool-status` in omp/pi to see backend health, latency, and request counts:

```
Pool Router Status
─────────────────────

Pool: pooled/glm-5.2
  Strategy: cache-affinity
  Backends:
    ✓ neuralwatt       lat=180ms inflight=0 reqs=42 errs=0
    ✓ getlilac         lat=195ms inflight=1 reqs=38 errs=1
    ✓ synthetic        lat=210ms inflight=0 reqs=15 errs=0
```

## How it works

```
Request: "Summarize this code..." (model: pooled/glm-5.2)
    │
    ▼
┌─────────────────────────────────────────────────┐
│ Pool Router Extension (registerProvider)        │
│                                                 │
│  1. Extract prefix (sessionId + system + user1) │
│  2. Filter backends by latency (10% band)       │
│  3. Hash prefix → position on ring             │
│  4. Binary search ring → backend                │
│  5. Dispatch to backend via streamSimple()      │
│  6. Measure TTFT → record latency               │
│  7. On connection error → failover to next     │
│                                                 │
└─────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────┐
│ Backend: neuralwatt (api.neuralwatt.com/v1)    │
│                                                 │
│  streamSimple() normalizes to                   │
│  AssistantMessageEvent → forwarded unchanged    │
│                                                 │
└─────────────────────────────────────────────────┘
```

## Benchmarks

Three load tests were run against 3 OpenAI-compatible backends (neuralwatt, getlilac, synthetic) serving `glm-5.2`. All tests implement the plugin's exact hash ring algorithm (150 virtual nodes, 128-bit bigint from first 16 bytes of SHA256, binary search walk) to measure the real routing logic — not omp cold-start overhead.

> **Note:** These tests measure backend cache-warmth and latency filtering under the two routing policies, implemented in a standalone Python script that matches the plugin's hash ring exactly. They do not exercise the omp `streamSimple` handler directly, but the routing decisions are identical.

### Test 1: Latency comparison (80 requests)

20 requests per run × 4 runs (repeated + unique prompts × cache-affinity + round-robin). `max_tokens=100`, shared system prompt (~1.5k tokens), TTFT = first token of any kind.

```
Strategy           Label               Reqs  OK | TTFT avg TTFT med TTFT p90 |  TOT avg  TOT med  TOT p90
───────────────────────────────────────────────────────────────────────────────────────────────────────────
cache-affinity     repeated-prefixes     20  20 |     1.34     0.93     2.62 |     2.34     1.36     5.14
round-robin        repeated-prefixes     20  20 |     1.42     1.25     3.02 |     2.74     2.23     4.92
cache-affinity     unique-prompts        20  20 |     1.24     1.19     1.77 |     2.65     2.45     5.07
round-robin        unique-prompts       20  20 |     1.54     1.25     3.04 |     3.34     2.62     6.76
```

**Results:**

| Metric | Repeated prompts | Unique prompts |
|---|---|---|
| TTFT | cache-affinity **6.1% faster** (1.34s vs 1.42s) | cache-affinity **19.8% faster** (1.24s vs 1.54s) |
| Total time | cache-affinity **14.6% faster** (2.34s vs 2.74s) | cache-affinity **20.8% faster** (2.65s vs 3.34s) |
| P90 TTFT | 2.62s vs 3.02s | 1.77s vs 3.04s |

**Key findings:**

- **cache-affinity wins across all metrics** — not just for repeated prompts. The total-time advantage is larger than TTFT, suggesting warm prefix caches also speed up token generation.
- **Unique prompts showed a 19.8% TTFT advantage** — this shouldn't exist if routing were the only variable. The explanation: cache-affinity's **latency pre-filter** excludes slow backends from the ring, while round-robin blindly rotates to all backends including slow ones.
- **P90 tail latency is dramatically better** — cache-affinity keeps degraded backends out of the selection pool (1.77s vs 3.04s for unique prompts).

### Test 2: Load distribution + cache hits (60 requests)

10 prompts, each sent 3× (30 requests per strategy). Measures which backend gets which request (distribution evenness) and whether prefix caches actually hit (`cached_tokens` from backend `usage` responses).

**Cache hit rate:**

| Strategy | Overall | First send | Repeat send | Cached tokens |
|---|---|---|---|---|
| cache-affinity | 63.3% (19/30) | 2/10 | **17/20** | 1728/4239 (40.8%) |
| round-robin | 66.7% (20/30) | 7/10 | **13/20** | 1728/4101 (42.1%) |

**Load distribution:**

| Backend | cache-affinity | round-robin |
|---|---|---|
| neuralwatt | 10 (33.3%) | 11 (36.7%) |
| getlilac | 12 (40.0%) | 10 (33.3%) |
| synthetic | 9 (30.0%) | 10 (33.3%) |
| **Evenness (CV)** | 14.8% | **5.6%** |

**TTFT — cache effect on repeats:**

| Strategy | First send | Repeat send | Speedup |
|---|---|---|---|
| cache-affinity | 3.62s | **1.31s** | **63.7% faster** |
| round-robin | 1.21s | 1.80s | **48.6% slower** |

**Key findings:**

- **cache-affinity preserves cache locality:** same prompt → same backend → prefix cache stays warm → repeats are 63.7% faster (3.62s → 1.31s).
- **round-robin busts the cache:** same prompt → different backend each time → cache stays cold → repeats are 48.6% slower than first sends (1.21s → 1.80s).
- **round-robin distributes more evenly** (CV 5.6% vs 14.8%) — with only 3 backends and 10 prompts, the hash ring assigns 3–4 prompts per backend, which is slightly uneven. Distribution evens out with more prompts.
- The overall cache hit *count* looks similar (66.7% vs 63.3%) because some backends have residual cache from prior traffic — but the **TTFT proves cache-affinity uses the cache effectively** while round-robin does not.

**Bottom line:** cache-affinity trades slightly less even distribution for dramatically better cache utilization. A 63.7% TTFT speedup on repeated prompts is worth the 9% distribution unevenness.

## Session-ID hashing

The hash prefix includes the `sessionId` from `SimpleStreamOptions`, not just the prompt content. This solves a critical problem in multi-turn coding sessions:

```
Prefix = [session:<id>] + systemPrompt + first_user_message
            ↑
      unique per session
```

### Why not hash the full conversation?

Each turn in a coding session adds messages, changing the conversation. If the hash included the full history, it would change every turn → different backend every turn → **zero cache hits ever**.

### Why not hash just prompt content?

Two different coding sessions that start with a similar first message (e.g. "Create a React component") would hash to the same backend, competing for each other's cache and causing eviction.

### How session-ID hashing works

```
Session A, Turn 5:  hash([session:abc] + system + user1) → backend A
                    → A has prefix cached from turns 1-4 → fast

Session B, Turn 1:  hash([session:xyz] + system + user1) → backend B
                    → different backend, no cache collision

Session A, Turn 6:  hash([session:abc] + system + user1) → backend A (SAME)
                    → A still has accumulated cache → fast
```

| Property | Behavior |
|---|---|
| Same session → same backend | ✅ Every turn routes to the same backend, cache accumulates |
| Different sessions → different backends | ✅ Unique sessionId produces different hash, no cache collision |
| Full conversation sent to backend | ✅ All messages sent in request body; only the *routing hash* is stable |
| `hash_prefix_chars` applies to prefix | ✅ Only first 4096 chars of the prefix string are hashed (not a moving target) |

### Test 3: Session-ID cache accumulation (60 requests)

10 sessions × 3 turns per session = 30 requests per strategy. Each session has a unique sessionId and growing conversation history (system prompt + increasing messages). Different system prompts and user messages per strategy to eliminate cache contamination.

`max_tokens=50`, system prompts ~100 tokens, TTFT = first token of any kind.

**Cache hit rate and accumulation:**

| Strategy | Overall | Turn 1 | Turn 2 | Turn 3 | Session stickiness |
|---|---|---|---|---|---|
| cache-affinity | 46.7% (14/30) | 30% (3/10) | 40% (4/10) | **70% (7/10)** | **100%** (10/10) |
| round-robin | 56.7% (17/30) | 70% (7/10) | 10% (1/10) | 90% (9/10) | **0%** (0/10) |

**Per-turn TTFT (cache accumulation effect):**

| Strategy | Turn 1 | Turn 2 | Turn 3 | Trend |
|---|---|---|---|---|
| cache-affinity | 3.81s | 1.21s | **1.16s** | ↓ 69.5% faster (cache accumulates) |
| round-robin | 1.59s | 2.03s | 3.03s | ↑ 90.7% slower (cache doesn't accumulate) |

**Overall latency:**

| Strategy | Mean | Median | P90 |
|---|---|---|---|
| cache-affinity | 2.06s | **1.12s** | **1.80s** |
| round-robin | 2.22s | 1.31s | 4.38s |

**Load distribution:**

| Backend | cache-affinity | round-robin |
|---|---|---|
| neuralwatt | 6 (20.0%) | 11 (36.7%) |
| getlilac | 15 (50.0%) | 10 (33.3%) |
| synthetic | 12 (40.0%) | 10 (33.3%) |
| **Evenness (CV)** | 41.7% | **5.6%** |

**Key findings:**

- **Session stickiness is perfect with cache-affinity (100%)** — every session stayed on the same backend for all 3 turns. Round-robin had 0% stickiness by design (each turn rotates to a different backend).
- **Cache accumulates with cache-affinity**: Turn 1 → 30% hit rate, Turn 2 → 40%, Turn 3 → 70%. The average cached tokens grew from 19 → 26 → 45 across turns.
- **Round-robin's Turn 1 had 70% cache hits** — an artifact of running after cache-affinity warmed shared backends. Despite this head start, cache round-robin's per-turn TTFT got *worse* not better: 1.59s → 2.03s → 3.03s.
- **cache-affinity P90 is 2.4× better** (1.80s vs 4.38s) — the latency pre-filter keeps degraded backends (like synthetic's cold-start spikes) out of the ring.
- **Round-robin's Turn 3 spike** (3.03s, 90.7% slower than Turn 1) happens because growing conversation + no cache affinity means each turn processes more tokens on a cold backend. Cache-affinity's Turn 3 is fastest (1.16s) because the backend has the full prefix cached.

## Configuration reference

### Pool

| Field | Type | Default | Description |
|---|---|---|---|
| `public_model` | string | required | Model name users reference (e.g. `pooled/glm-5.2`) |
| `strategy` | string | `cache-affinity` | Routing strategy |
| `strategy_args` | object | | Strategy tuning knobs |
| `members` | array | required | Backend definitions |

### strategy_args

| Field | Default | Description |
|---|---|---|
| `latency_buffer` | 0.1 | Keep backends within this fraction of the best latency |
| `hash_prefix_chars` | 4096 | Prompt prefix chars to hash for cache affinity |
| `max_in_flight_per_backend` | 3 | Overflow cap — walk to next backend if saturated |
| `ttl_seconds` | 3600 | Latency sample TTL — stale samples reset to default |

### Member

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | string | required | Unique backend id within the pool |
| `baseUrl` | string | required | Backend endpoint URL |
| `apiKey` | string | required | API key for this backend |
| `api` | string | `openai-completions` | pi-ai API id |
| `model` | string | pool's model | Model id override |
| `contextWindow` | number | 128000 | Context window in tokens |
| `maxTokens` | number | 16384 | Max output tokens |
| `reasoning` | boolean | false | Whether model supports reasoning |
| `input` | array | `["text"]` | Input modalities — `["text"]`, `["text", "image"]`, or `["image"]` |
| `headers` | object | | Extra headers to send |
| `healthCheck` | boolean | `true` | Background 1-token completion probe every 60s |

### Compatibility notes

- **`input` advertises, it does not gate.** The `input` field tells the host which modalities a pool accepts (used for the host's `vision` model role). The router does **not** strip image content from a request before dispatch — if you send images to a text-only pool, the backends receive them and reject with HTTP 400 (`... is not a multimodal model`). Route vision requests to a pool whose members declare `"input": ["text", "image"]`.

- **`developer` → `system` role normalization.** The host runs pi-ai's `openai-completions` provider upstream, which emits the OpenAI `"developer"` system-role alias for reasoning models (`useDeveloperRole ? "developer" : "system"`). Non-OpenAI backends (GLM, Kimi, DeepSeek) reject `"developer"` with HTTP 400 (`Model '...' does not support messages with role 'developer'`). `toOpenAIMessages` normalizes `developer` back to `system` before dispatch so non-OpenAI backends accept the message.

- **Capabilities are read from `members[0]` only.** `index.ts` derives the host-visible `input`, `reasoning`, `contextWindow`, and `maxTokens` from the first member of each pool. If a pool mixes multimodal and text-only backends, put the most capable member first so the host advertises the full modality set.

## License

MIT


---

## Key Features & Highlights

`pi-pool-router` is a pi/omp in-process extension that pools multiple independent LLM backends behind a single virtual provider (`pooled`), transparently handling routing, failover, health checks, and latency-aware selection. The notable engineering is in how the routing strategies, failover semantics, and backend state machine are composed together.

- **Consistent-hash `cache-affinity` routing** — The default strategy (`src/router.ts`) maintains a sorted ring of `RingNode`s. Each registering backend gets **150 virtual nodes** (`VIRTUAL_NODES = 150`) placed via SHA-256 (`hash()` reads the first 16 bytes of the digest into a 128-bit `bigint`). Selection is a textbook "walk clockwise" lookup: binary-search for the first node hash `>= promptHash`, with `lo = mid + 1` when `nodes[mid].hash < target` (the comment explicitly explains why the `+1` prevents an infinite loop), then wrap to index 0 if `lo === nodes.length`. The key payoff: the same prompt prefix always lands on the same backend, keeping the backend's prefix-cache warm — a deliberate cache-locality optimization.

- **Latency pre-filter before strategy dispatch** — Before the ring or round-robin cursor runs, the router (`Router.select`) computes `best = min(ewmaLatencyMs)` over eligible backends and keeps only those within `threshold = best * (1 + latencyBuffer)` (default `latency_buffer = 0.1` → ±10%). This silently drops degraded/slow backends from the candidate set each selection; the `if (latFiltered.length > 0) filtered = latFiltered` guard guarantees the filter never removes everyone. Slow backends stay excluded until their EWMA recovers.

- **EWMA latency tracking with staleness expiry** — `StateStore.recordLatency` uses a 30% decay (`LATENCY_DECAY = 0.3`, `ewma = ewma*(1-0.3) + sample*0.3`), so new TTFT samples dominate quickly but noise is smoothed. Crucially, `expireStaleLatency(poolModel, ttlMs)` resets `ewmaLatencyMs` back to the `DEFAULT_LATENCY_MS = 200` seed and clears `latencySamples` once a backend's `lastLatencyAt` is older than the TTL (`ttl_seconds` default 3600s). This prevents the pre-filter from permanently blackballing a backend that was slow an hour ago — stale data gracefully decays to neutral.

- **Two-phase circuit breaker (consecutive-fails → cooldown)** — `StateStore.recordFailure` increments `consecutiveFails` and `totalErrors`; at `MAX_CONSECUTIVE_FAILS = 3` it flips `health` to `"cooldown"`, sets `cooldownUntil = Date.now() + COOLDOWN_DURATION_MS` (60 s), and **resets `consecutiveFails` to 0** so the next failure window after the cooldown starts fresh. `getEligible` excludes anything in cooldown (`cooldownUntil > now`) or `health === "unhealthy"`. A separate `markUnhealthy` (used only by the health checker) skips the fail-accumulation gate and pushes straight to a 60s cooldown — immediate ejection for known-bad backends.

- **Low-cost active health probing via real inference** — `HealthChecker` (`src/health.ts`) fires every 60 s (`HEALTH_CHECK_INTERVAL_MS`) and sends an actual `POST /v1/chat/completions` with `messages: [{role:"user", content:"hi"}]` and `max_tokens: 1`. This exercises the full auth→model→response path rather than a TCP/HTTP ping — so a backend that answers health-checks but rejects the real model is still caught. Each probe has a 10 s `AbortController` timeout (`HEALTH_TIMEOUT_MS`). 2xx → `markHealthy`; non-2xx or throw → `recordFailure` (which feeds the circuit breaker). Per-member `healthCheck: false` opts out; `checkAll` runs all probes in parallel via `Promise.allSettled` so one slow backend cannot stall the sweep.

- **Prefix-cache-aware prompt hashing** — `hashPrompt(prefix, maxChars)` SHA-256-hashes only the first `hash_prefix_chars` (default 4096) of the prompt. Truncation bounds the hashing cost for very long contexts and, more importantly, keys the ring on the *prompt beginning* — the part an LLM backend is most likely to have KV-cached from an earlier identical turn. The input prefix is built by `extractPromptPrefix` (`src/stream.ts`): an optional `[session:<sessionId>]` tag, the system prompt, then the first three user messages — so a session's turn-to-turn routing is sticky and consistently different between sessions.

- **Fail-safe failover with partial-output protection** — `createStreamHandler`'s failover loop runs `maxAttempts = pool.members.length`, tracking tried backends in a `Set` and re-calling `router.select(..., tried)` each iteration. Failover only happens **if no event was pushed yet** (`if (firstEventReceived) break`) — once tokens have streamed to the user, switching backends would corrupt the output, so the router commits to the partial stream. Each backend records TTFT as latency on its first event (`onFirstEvent` → `state.recordSuccess(backendKey, ttft)`), and failures call `state.recordFailure(backendKey)` feeding the EWMA/circuit-breaker. If all backends exhaust, the user gets a synthesized error event rather than a hang.

- **Per-backend in-flight saturation guard** — During selection, any backend with `inFlight >= max_in_flight_per_backend` (default 3) is added to the exclude set before the ring runs. `acquire(key)`/`release(key)` mutate `inFlight` around each dispatch, and `release` uses `Math.max(0, inFlight - 1)` to defend against underflow on mis-paired releases. This spreads hot prompts across backends instead of hammering the ring winner, while keeping cache-affinity for idle backends.

- **Dual-host (pi + omp) single-codebase portability** — The extension is one codebase for both `pi-mono` (Zechner's `@mariozechner/*`) and `omp` (the `@oh-my-pi/*` fork). `detectHost()` (`src/config.ts`) resolves which runtime it's in via a deliberate precedence chain: (1) presence of `node_modules/@oh-my-pi` (omp's install-time import-rewrite hook); (2) omp's *own* env markers `OMP_PROFILE`/`OMP_AUTORESEARCH_DB_DIR`/`OMP_AUTH_BROKER_URL` — checked *before* `PI_CODING_AGENT` because omp, being a pi fork, inherits that marker too; (3) `PI_CODING_AGENT`; (4) `@mariozechner` layout; (5) a `pools.json` exist check; default `pi`. `findPoolsJson` then picks the running host's config dir first (`~/.pi/pools.json` vs `~/.omp/agent/pools.json`), with a CWD override and explicit zero-byte-file rejection so a stray empty file never shadows a valid config.

- **Custom `AssistantMessageEventStream` to dodge install-time validation** — Rather than `import { createAssistantMessageEventStream } from "@mariozechner/pi-ai"` (a static value import), `src/stream.ts` implements the stream contract locally as a hand-rolled async iterator with a `queue`, a `waiting` resolver slot, `isDone`, and a `result()` promise. The comment explains exactly why: omp's install-time extension validation can't resolve the `@mariozechner/*` value import (omp only rewrites those imports *at runtime* after validation passes). This keeps the extension loadable under both hosts without forking the source.

- **Provider-merging config validation** — `validateConfig` accepts duplicate `public_model` entries and **merges** their `members` into a single pool (the `existing.members.push(...members)` branch). This lets users split a large pool across multiple `pools.json` files/fragments without hand-merging. Validation enforces: `public_model` must contain `/` (the `pooled/<model>` contract), at least one member, required `id`/`baseUrl`/`apiKey` per member, and strategies must be in `{"cache-affinity","round-robin"}`. Missing `api` defaults to `"openai-completions"`; missing `model` defaults to `public_model.replace(/^pooled\//, "")` so a member automatically targets the pool's advertised model name.

- **Reasoning-level mapping across clients** — In `streamSimple`, pi-ai's `ThinkingLevel` (`"minimal"|"low"|"medium"|"high"|"xhigh"`) is mapped to OpenAI's `reasoning_effort` (`{"minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"high"}`), bridging pi-ai's richer taxonomy onto the OpenAI-compatible API the backends actually speak. Thinking/reasoning content (`delta.reasoning_content ?? delta.reasoning`) from DeepSeek/Kimi/GLM-class models is parsed into structured `thinking_start`/`thinking_delta`/`thinking_end` events, so reasoning streams render natively in the host UI instead of being dropped or dumped as plain text.
