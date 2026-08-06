/**
 * Durable alert delivery.
 *
 * `AlertManager` fans out to sinks in-process, which is fine for the stdout
 * sink — a container's log stream is always there. It is not fine for a
 * webhook: an outbound POST can fail, and an alert that fails to deliver is
 * simply gone. The alerts that matter most are exactly the ones raised while
 * something is already wrong, which is when a webhook is most likely to fail.
 *
 * So delivery goes through the Redis queue. Enqueuing is local and fast, the
 * worker retries with backoff, and an alert that cannot be delivered after
 * several attempts lands in the dead-letter list where an operator can find it
 * — rather than vanishing into a caught exception.
 *
 * This is what the queue is for in this system. Order submission deliberately
 * does *not* go through it: the OMS persists its intent to Postgres before
 * calling the broker and reconciles against the broker's own book afterwards,
 * so durability there is already handled by a stronger mechanism than a queue,
 * and interposing one would add latency to the path that most needs none.
 */

import type Redis from 'ioredis';
import type { Alert, AlertSink, MetricsRegistry } from './metrics';
import { METRICS } from './metrics';
import { RedisQueue, type Job } from '../messaging/queue';

const QUEUE_NAME = 'alerts';

export interface AlertDeliveryConfig {
  readonly redis: Redis;
  /** Where alerts are POSTed as JSON. */
  readonly webhookUrl: string;
  readonly metrics?: MetricsRegistry;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** How often the worker polls for due jobs. */
  readonly pollIntervalMs?: number;
}

export class AlertDelivery {
  private readonly queue: RedisQueue<Alert>;
  private readonly fetchImpl: typeof fetch;
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private running = false;

  constructor(private readonly config: AlertDeliveryConfig) {
    this.queue = new RedisQueue<Alert>(config.redis, {
      name: QUEUE_NAME,
      maxAttempts: config.maxAttempts ?? 5,
      backoffMs: 2_000,
      maxBackoffMs: 120_000,
    });
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  /**
   * An {@link AlertSink} that enqueues rather than delivers.
   *
   * Failing to *enqueue* is swallowed deliberately: `AlertManager` already
   * isolates sink failures, and an unreachable Redis must not turn every alert
   * into a second error. The stdout sink still gets it.
   */
  sink(): AlertSink {
    return async (alert: Alert) => {
      try {
        await this.queue.enqueue(alert);
      } catch {
        // Swallowed by design — see above.
      }
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Anything left in the processing list belongs to a worker that died
    // mid-delivery; without this it would sit there forever, and the queue
    // would look healthy while quietly holding an undelivered critical alert.
    void this.queue.recoverAbandoned().catch(() => undefined);

    const interval = this.config.pollIntervalMs ?? 1_000;
    this.timer = setInterval(() => {
      void this.pump();
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stops polling and waits for a delivery in flight. */
  async drain(): Promise<void> {
    this.stop();
    if (this.draining) await this.draining;
  }

  /** Drains whatever is currently due. Public so tests can step it. */
  async pump(limit = 10): Promise<number> {
    if (this.draining) return 0;

    const work = this.deliverBatch(limit);
    this.draining = work.then(() => undefined);
    try {
      return await work;
    } finally {
      this.draining = null;
    }
  }

  private async deliverBatch(limit: number): Promise<number> {
    let delivered = 0;

    for (let i = 0; i < limit; i += 1) {
      let job: Job<Alert> | null;
      try {
        job = await this.queue.claim();
      } catch {
        break;
      }
      if (!job) break;

      try {
        await this.deliver(job.payload);
        await this.queue.complete(job);
        delivered += 1;
      } catch (error) {
        const outcome = await this.queue.fail(
          job,
          error instanceof Error ? error.message : String(error),
        );
        if (outcome === 'dead') {
          console.error(JSON.stringify({
            level: 'error',
            msg: 'alert dead-lettered after repeated delivery failures',
            title: job.payload.title,
          }));
        }
      }
    }

    await this.reportDepth();
    return delivered;
  }

  private async deliver(alert: Alert): Promise<void> {
    if (!this.fetchImpl) throw new Error('no fetch implementation available');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);

    try {
      const response = await this.fetchImpl(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`webhook returned HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Publishes queue depth so a backlog is visible before it becomes an incident. */
  async reportDepth(): Promise<void> {
    if (!this.config.metrics) return;

    try {
      const depth = await this.queue.depth();
      this.config.metrics.setGauge(METRICS.queueDepth, depth.ready + depth.delayed, {
        queue: QUEUE_NAME,
      });
      this.config.metrics.setGauge(METRICS.queueDeadLetters, depth.dead, { queue: QUEUE_NAME });
    } catch {
      // A metrics update is never worth failing delivery over.
    }
  }

  depth(): Promise<{ ready: number; delayed: number; processing: number; dead: number }> {
    return this.queue.depth();
  }

  deadLetters(limit?: number): Promise<unknown[]> {
    return this.queue.deadLetters(limit);
  }
}
