/**
 * health.ts — background health checker
 *
 * Sends a minimal completion request (max_tokens: 1) to each backend every
 * 60 seconds. This exercises the full inference path (auth → model → response)
 * and costs a fraction of a cent per check. A 2xx response marks the backend
 * healthy; non-2xx or network errors accumulate toward cooldown.
 *
 * Health checks are ON by default. Disable per member with `"healthCheck": false`.
 */

import type { StateStore } from "./state.js";
import type { BackendState } from "./state.js";

const HEALTH_CHECK_INTERVAL_MS = 60_000;  // 60 seconds
const HEALTH_TIMEOUT_MS = 10_000;

/** Numeric handle from setInterval in Node.js / Bun */
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
    // Skip backends with healthCheck explicitly disabled
    const checkable = backends.filter((b) => b.member.healthCheck !== false);
    await Promise.allSettled(checkable.map((b) => this.checkOne(b)));
  }

  private async checkOne(backend: BackendState): Promise<void> {
    const key = this.state.key(backend.pool.public_model, backend.member.id);
    const url = backend.member.baseUrl.replace(/\/v1\/?$/, "") + "/v1/chat/completions";
    const model = backend.member.model ?? backend.pool.public_model.replace(/^pooled\//, "");

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${backend.member.apiKey}`,
          ...backend.member.headers,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        this.state.markHealthy(key);
      } else {
        this.state.recordFailure(key);
      }
    } catch (err) {
      this.state.recordFailure(key);
      console.warn(`[pool-router] Health check failed: ${backend.member.id}`, {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
