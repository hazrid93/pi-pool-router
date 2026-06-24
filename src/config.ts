/**
 * config.ts — pools.json loader with runtime validation
 *
 * Loads pool configuration from ~/.omp/agent/pools.json (omp) or ~/.pi/pools.json (pi).
 * The config is fully self-contained — no reference to models.yml.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  healthPath?: string;  // health check path (default: none — health checks off for this backend)
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

export function findPoolsJson(): string | null {
  const home = homedir();
  const candidates = [
    join(home, ".omp", "agent", "pools.json"),
    join(home, ".pi", "pools.json"),
    join(process.cwd(), "pools.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadConfig(path?: string): PoolConfig {
  const configPath = path ?? findPoolsJson();
  if (!configPath) {
    throw new Error(
      "No pools.json found. Create one at ~/.omp/agent/pools.json (omp) or ~/.pi/pools.json (pi)."
    );
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);
  return validateConfig(parsed);
}
