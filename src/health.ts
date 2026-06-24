/**
 * health.ts — background health checker
 *
 * Periodically pings each backend's /health endpoint (or a lightweight
 * models list call). If a backend responds, it's marked healthy.
 * If it times out or errors, consecutive failures accumulate.
 * After MAX_FAILS consecutive failures, the backend enters cooldown.
 *
 * This complements the request-path failure tracking in state.ts:
 * health checks catch backends that go down between requests,
 * so the router never sends traffic to a dead provider.
 */

import type { StateStore } from "./state.js";

const HEALTH_CHECK_INTERVAL_MS = 60_000;  // 60 seconds
const HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_PATH = "/health";  // LiteLLM proxy convention

export class HealthChecker {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private state: StateStore,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkAll().catch(() => {}), HEALTH_CHECK_INTERVAL_MS);
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
    await Promise.allSettled(backends.map((b) => this.checkOne(b)));
  }

  private async checkOne(backend: import("./state.js").BackendState): Promise<void> {
    const key = this.state.key(backend.pool.public_model, backend.member.id);
    const url = backend.member.baseUrl.replace(/\/v1\/?$/, "") + HEALTH_PATH;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      const res = await fetch(url, {
        method: "GET",
        headers: backend.member.headers ?? {},
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
