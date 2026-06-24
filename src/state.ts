/**
 * state.ts — in-memory backend state tracking
 *
 * Tracks per-backend: health, EWMA latency, in-flight request count,
 * cooldown status, and round-robin cursor.
 */

import type { BackendMember, Pool } from "./config.js";

export type HealthStatus = "healthy" | "unhealthy" | "cooldown";

export interface BackendState {
  member: BackendMember;
  pool: Pool;

  health: HealthStatus;
  consecutiveFails: number;

  ewmaLatencyMs: number;    // exponentially weighted moving average
  latencySamples: number;  // count of samples collected
  lastLatencyAt: number;    // timestamp (ms)

  inFlight: number;         // current concurrent requests
  lastSelectedAt: number;   // for round-robin / recency tracking
  totalRequests: number;
  totalErrors: number;

  cooldownUntil: number;    // timestamp (ms) when cooldown ends
}

const DEFAULT_LATENCY_MS = 200;
const LATENCY_DECAY = 0.3;  // 30% new sample, 70% history
const COOLDOWN_DURATION_MS = 60_000;
const MAX_CONSECUTIVE_FAILS = 3;

export class StateStore {
  private backends = new Map<string, BackendState>();  // key: `${pool.public_model}::${member.id}`

  registerPool(pool: Pool): void {
    for (const member of pool.members) {
      const key = this.key(pool.public_model, member.id);
      if (!this.backends.has(key)) {
        this.backends.set(key, {
          member,
          pool,
          health: "healthy",
          consecutiveFails: 0,
          ewmaLatencyMs: DEFAULT_LATENCY_MS,
          latencySamples: 0,
          lastLatencyAt: 0,
          inFlight: 0,
          lastSelectedAt: 0,
          totalRequests: 0,
          totalErrors: 0,
          cooldownUntil: 0,
        });
      }
    }
  }

  getBackends(poolModel: string): BackendState[] {
    const results: BackendState[] = [];
    for (const state of this.backends.values()) {
      if (state.pool.public_model === poolModel) {
        results.push(state);
      }
    }
    return results;
  }

  getEligible(poolModel: string): BackendState[] {
    const now = Date.now();
    return this.getBackends(poolModel).filter((b) => {
      // Check cooldown
      if (b.cooldownUntil > now) return false;
      // Check health
      if (b.health === "unhealthy") return false;
      return true;
    });
  }

  recordLatency(key: string, latencyMs: number): void {
    const b = this.backends.get(key);
    if (!b) return;
    b.ewmaLatencyMs = b.ewmaLatencyMs * (1 - LATENCY_DECAY) + latencyMs * LATENCY_DECAY;
    b.latencySamples++;
    b.lastLatencyAt = Date.now();
  }

  /**
   * Reset EWMA latency to default for backends whose last sample is older than ttlMs.
   * Stale latency data misleads the pre-filter — a backend that was slow an hour ago
   * may be fast now. Called by the router before the latency pre-filter runs.
   */
  expireStaleLatency(poolModel: string, ttlMs: number): void {
    if (ttlMs <= 0) return;
    const now = Date.now();
    for (const b of this.getBackends(poolModel)) {
      if (b.lastLatencyAt > 0 && now - b.lastLatencyAt > ttlMs) {
        b.ewmaLatencyMs = DEFAULT_LATENCY_MS;
        b.latencySamples = 0;
        b.lastLatencyAt = 0;
      }
    }
  }

  recordSuccess(key: string, latencyMs: number): void {
    const b = this.backends.get(key);
    if (!b) return;
    b.consecutiveFails = 0;
    b.health = "healthy";
    b.cooldownUntil = 0;
    this.recordLatency(key, latencyMs);
  }

  recordFailure(key: string): void {
    const b = this.backends.get(key);
    if (!b) return;
    b.consecutiveFails++;
    b.totalErrors++;
    if (b.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      b.health = "cooldown";
      b.cooldownUntil = Date.now() + COOLDOWN_DURATION_MS;
      b.consecutiveFails = 0;  // reset after entering cooldown
    }
  }

  acquire(key: string): void {
    const b = this.backends.get(key);
    if (!b) return;
    b.inFlight++;
    b.totalRequests++;
    b.lastSelectedAt = Date.now();
  }

  release(key: string): void {
    const b = this.backends.get(key);
    if (!b) return;
    b.inFlight = Math.max(0, b.inFlight - 1);
  }

  markUnhealthy(key: string): void {
    const b = this.backends.get(key);
    if (!b) return;
    b.health = "unhealthy";
    b.cooldownUntil = Date.now() + COOLDOWN_DURATION_MS;
  }

  markHealthy(key: string): void {
    const b = this.backends.get(key);
    if (!b) return;
    b.health = "healthy";
    b.cooldownUntil = 0;
    b.consecutiveFails = 0;
  }

  key(poolModel: string, memberId: string): string {
    return `${poolModel}::${memberId}`;
  }

  getState(key: string): BackendState | undefined {
    return this.backends.get(key);
  }

  getAllStates(): BackendState[] {
    return Array.from(this.backends.values());
  }
}
