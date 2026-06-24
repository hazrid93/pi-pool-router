/**
 * router.ts — routing strategies
 *
 * Strategies:
 * 1. cache-affinity (DEFAULT) — consistent hash ring on prompt prefix + latency pre-filter
 * 2. round-robin       — rotate through eligible backends
 *
 * The hash ring is a sorted array of backend hash positions.
 * "Walking clockwise" = binary search for the first position >= prompt hash, with wraparound.
 * When a backend is added/removed, only its portion of the ring shifts — the rest stays put.
 * This preserves prefix cache locality: same prompt → same backend → cache hit.
 */

import { createHash } from "node:crypto";
import type { BackendState } from "./state.js";
import { StateStore } from "./state.js";
import type { Pool } from "./config.js";

// ─── Consistent Hash Ring ────────────────────────────────────────────────────

const VIRTUAL_NODES = 150;

interface RingNode {
  hash: bigint;
  backendKey: string;
}

class ConsistentHashRing {
  private nodes: RingNode[] = [];

  rebuild(backends: BackendState[]): void {
    this.nodes = [];
    for (const b of backends) {
      const id = `${b.pool.public_model}::${b.member.id}`;
      for (let i = 0; i < VIRTUAL_NODES; i++) {
        const hash = this.hash(`${id}#${i}`);
        this.nodes.push({ hash, backendKey: id });
      }
    }
    this.nodes.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  }

  /**
   * Find the backend for a given prompt prefix hash.
   *
   * The ring is a sorted array of backend hash positions.
   * We binary-search for the first node whose hash >= promptHash.
   * If none exists (promptHash is larger than all nodes), wrap to index 0.
   *
   * This is "walk clockwise" on the ring visualization.
   * Binary search finds the insertion point — the first position that is >= our target.
   * `lo = mid + 1` when `nodes[mid].hash < target` because we've PROVEN mid is too small,
   * so we exclude it entirely. Without the +1, the search space can get stuck (infinite loop).
   */
  select(promptHash: bigint, exclude: Set<string>): string | null {
    let lo = 0;
    let hi = this.nodes.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.nodes[mid].hash < promptHash) {
        lo = mid + 1;  // mid is too small — proven wrong, exclude it
      } else {
        hi = mid;      // mid might be the answer — keep it, search left
      }
    }

    if (lo === this.nodes.length) lo = 0;  // wrap around (ring is circular)

    // Walk clockwise from lo, skipping excluded backends (saturated, cooldown)
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[(lo + i) % this.nodes.length];
      if (!exclude.has(node.backendKey)) {
        return node.backendKey;
      }
    }

    return null;  // all excluded
  }

  private hash(input: string): bigint {
    const buf = createHash("sha256").update(input).digest();
    // Use first 16 bytes as bigint (128-bit — enough for even distribution)
    let result = 0n;
    for (let i = 0; i < 16; i++) {
      result = (result << 8n) | BigInt(buf[i]);
    }
    return result;
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

export interface SelectionResult {
  backendKey: string;      // "${poolModel}::${memberId}"
  backend: BackendState;
}

export class Router {
  private ring = new ConsistentHashRing();
  private rrCursor = new Map<string, number>();  // poolModel → round-robin index

  constructor(private state: StateStore) {}

  select(
    pool: Pool,
    promptPrefix: string,
    now: number = Date.now(),
    tried: Set<string> = new Set(),
  ): SelectionResult | null {
    const eligible = this.state.getEligible(pool.public_model);
    if (eligible.length === 0) return null;

    const args = pool.strategy_args ?? {};
    const latencyBuffer = args.latency_buffer ?? 0.1;
    const hashPrefixChars = args.hash_prefix_chars ?? 4096;
    const maxInFlight = args.max_in_flight_per_backend ?? 3;
    const ttlMs = (args.ttl_seconds ?? 3600) * 1000;

    // Build the exclude set: tried (failed) + saturated backends
    const exclude = new Set<string>(tried);
    for (const b of eligible) {
      if (b.inFlight >= maxInFlight) {
        exclude.add(this.state.key(b.pool.public_model, b.member.id));
      }
    }
    // Expire stale latency samples before the pre-filter runs
    this.state.expireStaleLatency(pool.public_model, ttlMs);


    // ── Latency pre-filter ──
    // Find the best (lowest) latency among eligible backends.
    // Keep only those within `latencyBuffer` of the best.
    // This excludes slow/degraded backends before the strategy runs.
    let filtered = eligible.filter((b) => !exclude.has(this.state.key(b.pool.public_model, b.member.id)));
    if (filtered.length === 0) {
      // All excluded via tried+saturated — fall back to eligible minus tried
      filtered = eligible.filter((b) => !tried.has(this.state.key(b.pool.public_model, b.member.id)));
      if (filtered.length === 0) return null;  // every backend tried
    }
    if (latencyBuffer > 0 && filtered.length > 1) {
      const best = Math.min(...filtered.map((b) => b.ewmaLatencyMs));
      const threshold = best * (1 + latencyBuffer);
      const latFiltered = filtered.filter((b) => b.ewmaLatencyMs <= threshold);
      if (latFiltered.length > 0) filtered = latFiltered;  // safety: don't filter everything
    }

    // ── Strategy dispatch ──
    let backendKey: string | null = null;

    switch (pool.strategy) {
      case "cache-affinity": {
        // Build the ring from filtered backends.
        // Hash the prompt prefix to a position on the ring.
        // Binary-search for the first backend hash >= prompt hash (walk clockwise).
        // Same prompt → same position → same backend → prefix cache stays warm.
        // Different prompts → different positions → different backends → natural spread.
        this.ring.rebuild(filtered);
        const promptHash = this.hashPrompt(promptPrefix, hashPrefixChars);
        backendKey = this.ring.select(promptHash, exclude);
        break;
      }

      case "round-robin": {
        // Rotate through filtered backends.
        const idx = this.rrCursor.get(pool.public_model) ?? 0;
        const chosen = filtered[idx % filtered.length];
        this.rrCursor.set(pool.public_model, (idx + 1) % filtered.length);
        if (chosen) {
          backendKey = this.state.key(chosen.pool.public_model, chosen.member.id);
        }
        break;
      }
    }

    if (!backendKey) return null;
    const backend = this.state.getState(backendKey);
    if (!backend) return null;

    return { backendKey, backend };
  }

  private hashPrompt(prefix: string, maxChars: number): bigint {
    const truncated = prefix.slice(0, maxChars);
    const buf = createHash("sha256").update(truncated).digest();
    let result = 0n;
    for (let i = 0; i < 16; i++) {
      result = (result << 8n) | BigInt(buf[i]);
    }
    return result;
  }
}
