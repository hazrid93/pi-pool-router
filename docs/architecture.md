# Pool Router — Architecture

> A pi/omp in-process extension that replaces LiteLLM's pool routing natively. Define pools in a self-contained `pools.json` — the extension registers a custom provider that routes requests across backends using a **cache-affinity hash ring** with a latency pre-filter.

| | |
|---|---|
| **Language** | TypeScript · ES Modules |
| **Runtime** | Node.js 18+ / Bun · runs in-process under pi or omp |
| **Host Detection** | Auto-detects pi vs omp via `@oh-my-pi` namespace, env vars, and dependency layout |
| **Strategies** | `cache-affinity` (default, consistent hash ring) · `round-robin` |
| **Config** | `pools.json` at `~/.pi/pools.json` or `~/.omp/agent/pools.json` |
| **Health Checks** | Background polling every 60s — `max_tokens: 1` probe per backend |

---

## High-Level Architecture

```mermaid
flowchart TB
  subgraph Host["pi or omp host process"]
    PI["pi.registerProvider<br/>'pooled'"]
  end

  subgraph Ext["pool-router extension  (src)"]
    IDX["index.ts<br/>entry point"]
    CFG["config.ts<br/>load pools.json + detectHost"]
    STATE["state.ts<br/>StateStore — per-backend health,<br/>EWMA latency, in-flight, cooldown"]
    ROUTER["router.ts<br/>Router + ConsistentHashRing"]
    HEALTH["health.ts<br/>HealthChecker — 60s interval"]
    STREAM["stream.ts<br/>streamSimple — SSE dispatch + failover"]
  end

  subgraph Backends["LLM backends"]
    B1["backend-1<br/>OpenAI-compatible"]
    B2["backend-2<br/>OpenAI-compatible"]
    B3["backend-3<br/>OpenAI-compatible"]
  end

  PI --> IDX
  IDX --> CFG
  CFG --> STATE
  STATE --> ROUTER
  IDX --> HEALTH
  HEALTH --> STATE
  IDX --> STREAM
  STREAM --> ROUTER
  STREAM --> B1
  STREAM --> B2
  STREAM --> B3
  HEALTH --> B1
  HEALTH --> B2
  HEALTH --> B3
```

---

## Request Routing — Cache-Affinity Flow

```mermaid
sequenceDiagram
  participant Pi as pi host
  participant Stream as stream.ts
  participant Router as Router
  participant Ring as ConsistentHashRing
  participant State as StateStore
  participant Backend as Selected Backend

  Pi->>Stream: streamSimple(model, context, options)
  Stream->>Stream: extractPromptPrefix(messages, systemPrompt)
  Stream->>State: getEligible(poolModel)
  State-->>Stream: eligible backends (not in cooldown, healthy)

  alt no eligible backends
    Stream-->>Pi: error stream — all backends unavailable
  else eligible found
    Stream->>State: expireStaleLatency(poolModel)
    Stream->>Router: select(poolModel, promptHash, exclude)
    Router->>Router: latency pre-filter (EWMA within 10pct of best)
    Router->>Ring: select(promptHash, excludeSet)

    alt strategy: cache-affinity
      Ring->>Ring: binary search sorted ring<br/>for first hash >= promptHash
      alt no node >= promptHash
        Ring->>Ring: wrap to index 0 (circular ring)
      end
      Ring->>Ring: walk clockwise skipping excluded backends
      Ring-->>Router: backendKey
    else strategy: round-robin
      Router->>State: next backend by cursor
    end

    Router-->>Stream: selected backend
    Stream->>Backend: POST /v1/chat/completions (stream:true)
    Backend-->>Stream: SSE chunks
    Stream->>State: recordLatency(key, ttft)
    Stream-->>Pi: AssistantMessageEventStream

    alt connection error before first token
      Stream->>State: recordFailure(key)
      Stream->>Router: failover — add backend to exclude, re-select
      Router-->>Stream: next backend
      Stream->>Backend: retry POST
    end
  end
```

---

## Consistent Hash Ring — Selection Detail

The ring is a sorted array of `sha256` hash positions. Each backend gets 150 virtual nodes for even distribution. "Walking clockwise" = binary search for the first position >= the prompt hash, then scan forward skipping excluded backends.

```mermaid
flowchart LR
  PROMPT["Prompt prefix<br/>sha256 first 4096 chars"] --> RING["Sorted ring array<br/>150 virtual nodes per backend"]

  subgraph Ring["ConsistentHashRing.select"]
    BS["Binary search<br/>lo = mid + 1 when hash < target<br/>hi = mid when hash >= target"]
    BS --> FOUND{"First node<br/>>= promptHash?"}
    FOUND -- no --> WRAP["Wrap to index 0<br/>(ring is circular)"]
    FOUND -- yes --> WALK
    WRAP --> WALK["Walk clockwise<br/>skip excluded (saturated, cooldown)"]
    WALK --> SEL["Return backendKey"]
  end

  RING --> Ring
  SEL --> BACKEND["Selected backend<br/>prefix cache stays warm"]
```

**Why consistent?** When a backend goes down, only its prompts re-map — the rest stay put. Same prompt always hashes to the same position, so the same backend is selected (cache hit). If that backend is saturated or in cooldown, walk clockwise to the next.

---

## Backend State Machine

```mermaid
stateDiagram-v2
  [*] --> Healthy: registerPool
  Healthy --> Healthy: health check 2xx → markHealthy
  Healthy --> Unhealthy: health check non-2xx → recordFailure
  Unhealthy --> Unhealthy: consecutive fails < 3
  Unhealthy --> Cooldown: consecutive fails >= 3
  Cooldown --> Healthy: cooldownUntil expires + health check 2xx
  Cooldown --> Cooldown: cooldownUntil not expired

  note right of Healthy
    EWMA latency tracked
    inFlight incremented on select
    inFlight decremented on response
  end note

  note right of Cooldown
    cooldownUntil = now + 60s
    excluded from getEligible
    excluded from ring rebuild
  end note
```

---

## Health Check Loop

```mermaid
sequenceDiagram
  participant HC as HealthChecker
  participant State as StateStore
  participant Backend as Each backend

  loop every 60 seconds
    HC->>State: getAllStates()
    State-->>HC: all backends
    HC->>HC: filter healthCheck !== false

    par for each checkable backend
      HC->>Backend: POST /v1/chat/completions<br/>{ messages: [{role: user, content: hi}],<br/>max_tokens: 1, stream: false }
      Backend-->>HC: response
      alt 2xx
        HC->>State: markHealthy(key)
      else non-2xx or timeout
        HC->>State: recordFailure(key)
      end
    end
  end
```

---

## Latency Pre-Filter

Before the ring runs, backends are filtered by latency to exclude slow or degraded nodes while preserving cache locality among the fast ones.

```mermaid
flowchart TD
  ELIG["getEligible backends<br/>not in cooldown, healthy"] --> EXPIRE["expireStaleLatency<br/>reset EWMA if sample is stale"]
  EXPIRE --> MIN["Find lowest EWMA latency<br/>among eligible backends"]
  MIN --> BUF["Keep only those within<br/>latency_buffer (default 10pct) of best"]
  BUF --> RING["Build ring from survivors only"]
  RING --> SELECT["ConsistentHashRing.select"]
```

---

## Configuration Loading

```mermaid
flowchart TB
  START["loadConfig called"] --> DETECT["detectHost"]
  DETECT --> CHECK_OMP{"@oh-my-pi<br/>namespace present?"}
  CHECK_OMP -- yes --> OMP["host = omp"]
  CHECK_OMP -- no --> CHECK_ENV{"OMP_PROFILE<br/>or OMP_* env set?"}
  CHECK_ENV -- yes --> OMP
  CHECK_ENV -- no --> CHECK_PI{"PI_CODING_AGENT<br/>set?"}
  CHECK_PI -- yes --> PI["host = pi"]
  CHECK_PI -- no --> CHECK_DEP["@mariozechner<br/>in node_modules?"]
  CHECK_DEP -- yes --> PI
  CHECK_DEP -- no --> CHECK_FILE["pools.json exists<br/>in ~/.omp or ~/.pi?"]
  CHECK_FILE -- "~/.omp" --> OMP
  CHECK_FILE -- "~/.pi" --> PI
  CHECK_FILE -- neither --> PI

  OMP --> LOAD_OMP["load ~/.omp/agent/pools.json"]
  PI --> LOAD_PI["load ~/.pi/pools.json"]
  LOAD_OMP --> VALIDATE
  LOAD_PI --> VALIDATE
  VALIDATE["Validate: pools array,<br/>public_model, strategy,<br/>members with baseUrl + apiKey"]
  VALIDATE --> CWD["Check cwd/pools.json<br/>(manual override, checked last)"]
  CWD --> DONE["Return PoolConfig"]
```

**Host-aware loading** prevents a stray `pools.json` under the other host's directory from shadowing a valid config. Each host loads from its own path first.
