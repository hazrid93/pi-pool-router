/**
 * config.ts — pools.json loader with runtime validation
 *
 * Loads pool configuration from ~/.pi/pools.json (pi) or ~/.omp/agent/pools.json (omp).
 * Host is auto-detected (see detectHost) — the running host's path is tried first,
 * so an empty or stray file under the *other* host's dir never shadows a valid config.
 * Empty candidates are skipped with a warning. The config is fully self-contained.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __moduleDir =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

// ─── Host detection ─────────────────────────────────────────────────────────
// The extension runs under both pi (pi-mono) and omp. omp installs its deps
// under "@oh-my-pi/*" via an install-time import-rewrite hook; pi keeps
// "@mariozechner/*". We use that + the PI_CODING_AGENT env var to detect host,
// so each host loads config from its own dir (~/.pi vs ~/.omp/agent) and an
// empty/stray file under the *other* host's dir can never shadow a valid one.

export type HostApp = "pi" | "omp";

export function detectHost(): HostApp {
  // 1. Strongest signal: pi-mono sets PI_CODING_AGENT=true at launch.
  if (process.env.PI_CODING_AGENT) return "pi";
  // 2. Dependency layout: omp rewrites to @oh-my-pi, pi keeps @mariozechner.
  const nm = join(__moduleDir, "..", "node_modules");
  if (existsSync(join(nm, "@oh-my-pi"))) return "omp";
  if (existsSync(join(nm, "@mariozechner"))) return "pi";
  // 3. Last resort: whichever config dir already has a pools.json.
  const home = homedir();
  if (existsSync(join(home, ".omp", "agent", "pools.json"))) return "omp";
  if (existsSync(join(home, ".pi", "pools.json"))) return "pi";
  // Default — repo origin is pi.
  return "pi";
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type RoutingStrategy = "cache-affinity" | "round-robin";

export interface BackendMember {
  id: string;           // unique backend id within the pool
  baseUrl: string;      // e.g. http://127.0.0.1:4000/v1
  apiKey: string;       // API key for this backend
  api: string;          // pi-ai api id, e.g. "openai-completions"
  model?: string;       // model id override (default: pool's public_model)
  headers?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];  // input modalities (default: ["text"])
  healthCheck?: boolean;  // enable background health probe (default: true)
}

export interface Pool {
  public_model: string;        // e.g. "pooled/glm-5.2" — what the user references
  strategy: RoutingStrategy;   // routing strategy (default: cache-affinity)
  strategy_args?: {
    latency_buffer?: number;        // 0.1 = 10% band (default 0.1)
    hash_prefix_chars?: number;     // prefix chars to hash (default 4096)
    max_in_flight_per_backend?: number; // overflow cap (default 3)
    ttl_seconds?: number;           // latency sample TTL (default 3600)
  };
  members: BackendMember[];
}

export interface PoolConfig {
  pools: Pool[];
}

// ─── Validation ─────────────────────────────────────────────────────────────

export function validateConfig(config: unknown): PoolConfig {
  if (typeof config !== "object" || config === null) {
    throw new Error("pools.json: expected an object with a 'pools' array");
  }
  const c = config as Record<string, unknown>;
  if (!Array.isArray(c.pools)) {
    throw new Error("pools.json: 'pools' must be an array");
  }

  const pools: Pool[] = [];
  const seenPublicModels = new Set<string>();

  for (let i = 0; i < c.pools.length; i++) {
    const raw = c.pools[i] as Record<string, unknown>;
    const publicModel = raw.public_model as string;
    if (!publicModel) {
      throw new Error(`pools.json: pool[${i}] missing 'public_model'`);
    }
    if (!publicModel.includes("/")) {
      throw new Error(`pools.json: pool '${publicModel}' must use format 'pooled/<model>' — missing '/'`);
    }
    if (seenPublicModels.has(publicModel)) {
      // Entries with the same public_model are merged into one pool
      const existing = pools.find((p) => p.public_model === publicModel);
      if (existing) {
        const members = raw.members as BackendMember[];
        if (Array.isArray(members)) existing.members.push(...members);
        continue;
      }
    }
    seenPublicModels.add(publicModel);

    const VALID_STRATEGIES = new Set<string>(["cache-affinity", "round-robin"]);
    const rawStrategy = raw.strategy as string | undefined;
    if (rawStrategy !== undefined && !VALID_STRATEGIES.has(rawStrategy)) {
      throw new Error(`pools.json: pool '${publicModel}' has invalid strategy '${rawStrategy}' — must be one of: ${[...VALID_STRATEGIES].join(", ")}`);
    }
    const strategy = (rawStrategy as RoutingStrategy) ?? "cache-affinity";
    const strategyArgs = raw.strategy_args as Pool["strategy_args"];
    const members = raw.members as BackendMember[];

    if (!Array.isArray(members) || members.length === 0) {
      throw new Error(`pools.json: pool '${publicModel}' must have at least one member`);
    }

    for (let j = 0; j < members.length; j++) {
      const m = members[j];
      if (!m.id) throw new Error(`pools.json: pool '${publicModel}' member[${j}] missing 'id'`);
      if (!m.baseUrl) throw new Error(`pools.json: pool '${publicModel}' member '${m.id}' missing 'baseUrl'`);
      if (!m.apiKey) throw new Error(`pools.json: pool '${publicModel}' member '${m.id}' missing 'apiKey'`);
      if (!m.api) m.api = "openai-completions";
      if (m.model === undefined) m.model = publicModel.replace(/^pooled\//, "");
    }

    pools.push({
      public_model: publicModel,
      strategy,
      strategy_args: strategyArgs,
      members,
    });
  }

  return { pools };
}

// ─── Loader ─────────────────────────────────────────────────────────────────

export function findPoolsJson(host?: HostApp): string | null {
  const h = host ?? detectHost();
  const home = homedir();
  const piPath = join(home, ".pi", "pools.json");
  const ompPath = join(home, ".omp", "agent", "pools.json");
  const cwdPath = join(process.cwd(), "pools.json");
  // Running host first, then the other host, then cwd (manual override).
  const candidates = h === "omp" ? [ompPath, piPath, cwdPath] : [piPath, ompPath, cwdPath];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    // Skip empty/zero-byte files so a stray file can never shadow a valid config.
    try {
      if (statSync(p).size === 0) {
        console.warn(`[pool-router] ignoring empty pools.json at ${p}`);
        continue;
      }
    } catch {
      continue;
    }
    return p;
  }
  return null;
}

export function loadConfig(path?: string): PoolConfig {
  const configPath = path ?? findPoolsJson();
  if (!configPath) {
    throw new Error(
      "No pools.json found. Create one at ~/.pi/pools.json (pi) or ~/.omp/agent/pools.json (omp)."
    );
  }
  const raw = readFileSync(configPath, "utf-8");
  if (raw.trim() === "") {
    throw new Error(`pools.json at ${configPath} is empty. Remove it or fill in a valid config.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`pools.json at ${configPath} is not valid JSON: ${(e as Error).message}`);
  }
  return validateConfig(parsed);
}
