/**
 * Redis-backed work queue with retries and a dead-letter list.
 *
 * Used for work that must survive a process restart: order submissions,
 * reconciliation sweeps, model training runs, alert delivery.
 *
 * The delivery guarantee is **at-least-once**, and that is a deliberate choice
 * rather than a limitation to apologise for. At-most-once would mean an order
 * submission could be silently dropped by a crash; at-least-once means it can
 * be delivered twice. The platform already makes duplicate submission
 * harmless — idempotency keys are derived from the intent and enforced UNIQUE
 * in Postgres — so a duplicate delivery is absorbed, while a dropped one would
 * not be.
 *
 * Claimed jobs go to a processing list and are moved back if the worker dies,
 * so a crash mid-job does not lose it.
 */

import type Redis from 'ioredis';

export interface Job<T> {
  readonly id: string;
  readonly payload: T;
  readonly attempts: number;
  readonly enqueuedAt: number;
  /** Earliest time this job may run — set when a retry is scheduled. */
  readonly runAt: number;
}

export interface QueueConfig {
  readonly name: string;
  readonly maxAttempts?: number;
  /** Base backoff; doubles per attempt. */
  readonly backoffMs?: number;
  /** Cap on the exponential backoff. */
  readonly maxBackoffMs?: number;
  /** How long a claimed job may run before it is considered abandoned. */
  readonly visibilityTimeoutMs?: number;
}

export class RedisQueue<T> {
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly visibilityTimeoutMs: number;

  private readonly readyKey: string;
  private readonly delayedKey: string;
  private readonly processingKey: string;
  private readonly deadKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly config: QueueConfig,
  ) {
    this.maxAttempts = config.maxAttempts ?? 3;
    this.backoffMs = config.backoffMs ?? 1000;
    this.maxBackoffMs = config.maxBackoffMs ?? 60_000;
    this.visibilityTimeoutMs = config.visibilityTimeoutMs ?? 60_000;

    const base = `queue:${config.name}`;
    this.readyKey = `${base}:ready`;
    this.delayedKey = `${base}:delayed`;
    this.processingKey = `${base}:processing`;
    this.deadKey = `${base}:dead`;
  }

  async enqueue(payload: T, id?: string, delayMs = 0): Promise<string> {
    const jobId = id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const job: Job<T> = { id: jobId, payload, attempts: 0, enqueuedAt: now, runAt: now + delayMs };
    const encoded = JSON.stringify(job);

    if (delayMs > 0) {
      await this.redis.zadd(this.delayedKey, job.runAt, encoded);
    } else {
      await this.redis.lpush(this.readyKey, encoded);
    }
    return jobId;
  }

  /**
   * Moves any delayed jobs whose time has come onto the ready list.
   *
   * Called by {@link claim}, so a worker loop needs no separate scheduler.
   */
  async promoteDelayed(now = Date.now()): Promise<number> {
    const due = await this.redis.zrangebyscore(this.delayedKey, '-inf', now);
    if (due.length === 0) return 0;

    const pipeline = this.redis.multi();
    for (const encoded of due) {
      pipeline.lpush(this.readyKey, encoded);
      pipeline.zrem(this.delayedKey, encoded);
    }
    await pipeline.exec();
    return due.length;
  }

  /**
   * Claims the next job, moving it atomically to the processing list.
   *
   * `RPOPLPUSH` is what makes the claim crash-safe: the job is never in
   * neither list, so a worker dying between pop and handle cannot lose it.
   */
  async claim(now = Date.now()): Promise<Job<T> | null> {
    await this.promoteDelayed(now);

    const encoded = await this.redis.rpoplpush(this.readyKey, this.processingKey);
    if (!encoded) return null;

    const job = JSON.parse(encoded) as Job<T>;
    await this.redis.hset(`${this.processingKey}:claimed`, job.id, String(now));
    return job;
  }

  /** Marks a job done and removes it from the processing list. */
  async complete(job: Job<T>): Promise<void> {
    await this.redis.lrem(this.processingKey, 1, JSON.stringify(job));
    await this.redis.hdel(`${this.processingKey}:claimed`, job.id);
  }

  /**
   * Records a failure: schedules a retry with exponential backoff, or
   * dead-letters the job once attempts are exhausted.
   *
   * Dead-lettered rather than dropped — a job that failed three times is
   * something an operator needs to see, not something to forget.
   */
  async fail(job: Job<T>, reason: string, now = Date.now()): Promise<'retried' | 'dead'> {
    await this.redis.lrem(this.processingKey, 1, JSON.stringify(job));
    await this.redis.hdel(`${this.processingKey}:claimed`, job.id);

    const attempts = job.attempts + 1;

    if (attempts >= this.maxAttempts) {
      await this.redis.lpush(
        this.deadKey,
        JSON.stringify({ ...job, attempts, failedAt: now, reason }),
      );
      return 'dead';
    }

    const backoff = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (attempts - 1));
    const retry: Job<T> = { ...job, attempts, runAt: now + backoff };
    await this.redis.zadd(this.delayedKey, retry.runAt, JSON.stringify(retry));
    return 'retried';
  }

  /**
   * Returns jobs abandoned by a dead worker to the ready list.
   *
   * Without this a crash mid-job leaves it in the processing list forever —
   * the queue would look healthy while quietly losing work.
   */
  async recoverAbandoned(now = Date.now()): Promise<number> {
    const claimed = await this.redis.hgetall(`${this.processingKey}:claimed`);
    const processing = await this.redis.lrange(this.processingKey, 0, -1);
    let recovered = 0;

    for (const encoded of processing) {
      const job = JSON.parse(encoded) as Job<T>;
      const claimedAt = Number(claimed[job.id] ?? 0);
      if (claimedAt > 0 && now - claimedAt < this.visibilityTimeoutMs) continue;

      await this.redis.lrem(this.processingKey, 1, encoded);
      await this.redis.hdel(`${this.processingKey}:claimed`, job.id);
      await this.redis.lpush(this.readyKey, encoded);
      recovered += 1;
    }

    return recovered;
  }

  async depth(): Promise<{ ready: number; delayed: number; processing: number; dead: number }> {
    const [ready, delayed, processing, dead] = await Promise.all([
      this.redis.llen(this.readyKey),
      this.redis.zcard(this.delayedKey),
      this.redis.llen(this.processingKey),
      this.redis.llen(this.deadKey),
    ]);
    return { ready, delayed, processing, dead };
  }

  async deadLetters(limit = 50): Promise<unknown[]> {
    const raw = await this.redis.lrange(this.deadKey, 0, limit - 1);
    return raw.map((entry) => JSON.parse(entry) as unknown);
  }

  /** Clears every list for this queue. Tests and operator recovery only. */
  async drain(): Promise<void> {
    await this.redis.del(
      this.readyKey, this.delayedKey, this.processingKey, this.deadKey,
      `${this.processingKey}:claimed`,
    );
  }
}

/**
 * Pub/sub fan-out for live updates.
 *
 * Deliberately separate from {@link RedisQueue}: this is best-effort and
 * ephemeral (a dashboard that misses a tick just redraws on the next one),
 * whereas the queue is durable. Conflating the two leads to either a
 * dashboard that blocks order flow, or orders delivered with a dashboard's
 * reliability.
 */
export class EventBus {
  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly channel = 'events',
  ) {}

  async publish(event: { type: string; payload: unknown }): Promise<void> {
    await this.publisher.publish(this.channel, JSON.stringify({ ...event, at: Date.now() }));
  }

  async subscribe(handler: (event: { type: string; payload: unknown; at: number }) => void): Promise<void> {
    await this.subscriber.subscribe(this.channel);
    this.subscriber.on('message', (_channel, message) => {
      try {
        handler(JSON.parse(message) as { type: string; payload: unknown; at: number });
      } catch {
        // A malformed message must not take down the subscriber loop.
      }
    });
  }

  async close(): Promise<void> {
    await this.subscriber.unsubscribe(this.channel).catch(() => undefined);
  }
}
