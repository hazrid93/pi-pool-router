/**
 * health.ts — background health checker
 *
 * Periodically pings each backend's health endpoint if one is configured.
 * If a backend responds 2xx, it's marked healthy. Non-2xx or network errors
 * accumulate consecutive failures toward cooldown.
 *
 * Health checks are OFF by default — only backends with a `healthPath` field
 * in pools.json are checked. Commercial OpenAI-compatible APIs (NeuralWatt,
 * GetLilac, Synthetic) typically don't expose /health, so forcing checks
 * would mark them unhealthy after 3 failed pings.
 *
 * For LiteLLM proxy backends, set `"healthPath": "/health"` per member.
 */

import type { StateStore } from "./state.js";
import type { BackendState } from "./state.js";

const HEALTH_CHECK_INTERVAL_MS = 60_000;  // 60 seconds
const HEALTH_TIMEOUT_MS = 5_000;

/** Numeric handle from setInterval in Node.js */
type IntervalHandle = number;

export class HealthChecker {
  private timer: IntervalHandle | null = null;

  constructor(
    private state: StateStore,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkAll().catch(() => {}), HEALTH_CHECK_INTERVAL_MS) as unknown as IntervalHandle;
    // Run one immediate check
    this.checkAll().catch(() => {});
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkAll(): Promise<void> {
    const backends = this.state.getAllStates();
    // Only check backends that have a healthPath configured
    const checkable = backends.filter((b) => b.member.healthPath);
    await Promise.allSettled(checkable.map((b) => this.checkOne(b)));
  }

  private async checkOne(backend: BackendState): Promise<void> {
    const key = this.state.key(backend.pool.public_model, backend.member.id);
    const healthPath = backend.member.healthPath;
    if (!healthPath) return;

    const url = backend.member.baseUrl.replace(/\/v1\/?$/, "") + healthPath;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      const res = await fetch(url, {
        method: "GET",
        headers: { ...backend.member.headers },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        this.state.markHealthy(key);
      } else {
        // Non-2xx — record failure (accumulates toward cooldown)
        this.state.recordFailure(key);
      }
    } catch (err) {
      // Network error or timeout — record as failure
      this.state.recordFailure(key);
      console.warn(`[pool-router] Health check failed: ${backend.member.id}`, {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
