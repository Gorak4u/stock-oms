/**
 * Append-only audit trail.
 *
 * Complete auditability means being able to answer "why did the system place
 * *this* order at *this* time" months later, without inference. Every decision
 * point — signal, risk verdict, submission, fill, breaker trip, kill-switch
 * change — writes one immutable record.
 *
 * Records are hash-chained: each carries the hash of its predecessor, so a
 * record edited or removed after the fact breaks the chain and
 * {@link verifyChain} finds it. That matters for a system that moves money,
 * where the log may be the only evidence of what happened.
 */

import { createHash } from 'node:crypto';
import type { Timestamp } from '../domain/types';

export type AuditEventType =
  | 'SIGNAL_GENERATED'
  | 'RISK_APPROVED'
  | 'RISK_REJECTED'
  | 'ORDER_STAGED'
  | 'ORDER_SUBMITTED'
  | 'ORDER_ACKNOWLEDGED'
  | 'ORDER_REJECTED'
  | 'ORDER_CANCELLED'
  | 'FILL_RECEIVED'
  | 'POSITION_CLOSED'
  /**
   * An operator closed a position by hand, rather than a strategy or the
   * square-off deciding to. Distinct from `ORDER_SUBMITTED` because "who
   * flattened this, and when" is a question asked after an incident, and the
   * answer must not have to be inferred from an order's strategyId.
   */
  | 'MANUAL_EXIT'
  | 'KILL_SWITCH_ENGAGED'
  | 'KILL_SWITCH_RELEASED'
  | 'BREAKER_TRIPPED'
  | 'RECONCILIATION_BREAK'
  | 'MODE_CHANGED';

export interface AuditRecord {
  readonly sequence: number;
  readonly timestamp: Timestamp;
  readonly type: AuditEventType;
  /** Correlates every record produced by one signal-to-fill journey. */
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly previousHash: string;
  readonly hash: string;
}

export interface AuditSink {
  append(
    type: AuditEventType,
    correlationId: string,
    payload: Record<string, unknown>,
    timestamp: Timestamp,
  ): AuditRecord;
}

const GENESIS_HASH = '0'.repeat(64);

function hashRecord(record: Omit<AuditRecord, 'hash'>): string {
  // Keys are sorted so the hash is stable regardless of insertion order.
  const canonical = JSON.stringify(
    {
      sequence: record.sequence,
      timestamp: record.timestamp,
      type: record.type,
      correlationId: record.correlationId,
      payload: record.payload,
      previousHash: record.previousHash,
    },
    (_key, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        );
      }
      return value;
    },
  );

  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * In-memory hash-chained audit log.
 *
 * Production writes the same records to Postgres and ships them to object
 * storage; this implementation is what backtests and tests use, and it defines
 * the contract the durable one must satisfy.
 */
export class InMemoryAuditLog implements AuditSink {
  private readonly records: AuditRecord[] = [];
  private resumeSequence = 0;
  private resumeHash = GENESIS_HASH;

  /**
   * Continues an existing chain after a restart.
   *
   * Without this the log restarts at sequence 1 with a genesis predecessor,
   * which both collides with the sequences already stored and silently forks
   * the hash chain — the durable log would no longer verify end to end. Called
   * on startup with the persisted head.
   */
  resumeFrom(sequence: number, hash: string): void {
    if (this.records.length > 0) {
      throw new Error('cannot resume a chain that has already been appended to');
    }
    this.resumeSequence = sequence;
    this.resumeHash = hash;
  }

  append(
    type: AuditEventType,
    correlationId: string,
    payload: Record<string, unknown>,
    timestamp: Timestamp,
  ): AuditRecord {
    const previousHash = this.records[this.records.length - 1]?.hash ?? this.resumeHash;
    const partial = {
      sequence: this.resumeSequence + this.records.length + 1,
      timestamp,
      type,
      correlationId,
      payload: { ...payload },
      previousHash,
    };

    const record: AuditRecord = { ...partial, hash: hashRecord(partial) };
    this.records.push(record);
    return record;
  }

  all(): readonly AuditRecord[] {
    return this.records;
  }

  /** Every record for one signal-to-fill journey, in order. */
  byCorrelation(correlationId: string): AuditRecord[] {
    return this.records.filter((record) => record.correlationId === correlationId);
  }

  byType(type: AuditEventType): AuditRecord[] {
    return this.records.filter((record) => record.type === type);
  }

  /**
   * Re-derives every hash and checks the chain.
   *
   * Returns the sequence number of the first record that fails, or `null` when
   * the log is intact.
   */
  verifyChain(): number | null {
    // Starts from the resumed head, not genesis, so a chain continued across
    // a restart still verifies over the records this process appended.
    let previousHash = this.resumeHash;

    for (const record of this.records) {
      if (record.previousHash !== previousHash) return record.sequence;

      const { hash, ...rest } = record;
      if (hashRecord(rest) !== hash) return record.sequence;

      previousHash = hash;
    }

    return null;
  }

  get size(): number {
    return this.records.length;
  }
}
