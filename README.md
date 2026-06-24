# Pool Router

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

Place at `~/.omp/agent/pools.json` (omp) or `~/.pi/pools.json` (pi):

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
pi plugin install github:hazrid93/pi-pool-router
```

**Local dev:**
```bash
omp plugin link ./path/to/pi-pool-router
```

> Marketplace installs do NOT load extension modules — use `github:` spec or `plugin link` for local dev.

### 3. Update `models.yml`

Remove the old provider and let the extension register `pooled/*` providers:

```yaml
# Remove the old "litellm" provider block entirely.
# The extension registers "pooled" as a provider with the pool's models.
```

### 4. Update `config.yml` roles

Point roles at the pooled models:

```yaml
modelRoles:
  default: pooled/glm-5.2:xhigh
  vision: pooled/glm-5.2:off
  advisor: pooled/glm-5.2:xhigh
  plan: pooled/glm-5.2:xhigh
```

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
│  1. Extract prompt prefix (system + first user) │
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

## License

MIT
