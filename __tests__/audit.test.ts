import { InMemoryAuditLog } from '../src/audit/log';

describe('InMemoryAuditLog', () => {
  it('numbers records from one and chains each to its predecessor', () => {
    const log = new InMemoryAuditLog();
    const first = log.append('SIGNAL_GENERATED', 'corr-1', { symbol: 'A' }, 1);
    const second = log.append('RISK_APPROVED', 'corr-1', { quantity: 10 }, 2);

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.previousHash).toBe('0'.repeat(64));
    expect(second.previousHash).toBe(first.hash);
  });

  it('verifies an untampered chain', () => {
    const log = new InMemoryAuditLog();
    for (let i = 0; i < 20; i += 1) {
      log.append('FILL_RECEIVED', `corr-${i}`, { index: i }, i);
    }

    expect(log.verifyChain()).toBeNull();
    expect(log.size).toBe(20);
  });

  it('detects a payload edited after the fact', () => {
    const log = new InMemoryAuditLog();
    log.append('ORDER_SUBMITTED', 'corr-1', { quantity: 10 }, 1);
    log.append('ORDER_SUBMITTED', 'corr-2', { quantity: 20 }, 2);
    log.append('ORDER_SUBMITTED', 'corr-3', { quantity: 30 }, 3);

    // Reach past the API and rewrite history, as an attacker with DB access would.
    const records = log.all() as unknown as { payload: Record<string, unknown> }[];
    records[1]!.payload = { quantity: 999 };

    expect(log.verifyChain()).toBe(2);
  });

  it('detects a removed record', () => {
    const log = new InMemoryAuditLog();
    log.append('ORDER_SUBMITTED', 'c1', { n: 1 }, 1);
    log.append('ORDER_SUBMITTED', 'c2', { n: 2 }, 2);
    log.append('ORDER_SUBMITTED', 'c3', { n: 3 }, 3);

    (log.all() as unknown as unknown[]).splice(1, 1);

    // The survivor's previousHash no longer matches what precedes it.
    expect(log.verifyChain()).toBe(3);
  });

  it('hashes independently of key insertion order', () => {
    const a = new InMemoryAuditLog();
    const b = new InMemoryAuditLog();

    const first = a.append('SIGNAL_GENERATED', 'c', { alpha: 1, beta: 2 }, 1);
    const second = b.append('SIGNAL_GENERATED', 'c', { beta: 2, alpha: 1 }, 1);

    expect(first.hash).toBe(second.hash);
  });

  it('reconstructs one signal-to-fill journey by correlation id', () => {
    const log = new InMemoryAuditLog();
    log.append('SIGNAL_GENERATED', 'trade-1', {}, 1);
    log.append('SIGNAL_GENERATED', 'trade-2', {}, 2);
    log.append('RISK_APPROVED', 'trade-1', {}, 3);
    log.append('ORDER_SUBMITTED', 'trade-1', {}, 4);
    log.append('FILL_RECEIVED', 'trade-1', {}, 5);

    const journey = log.byCorrelation('trade-1');
    expect(journey.map((record) => record.type)).toEqual([
      'SIGNAL_GENERATED',
      'RISK_APPROVED',
      'ORDER_SUBMITTED',
      'FILL_RECEIVED',
    ]);
  });

  it('filters by event type', () => {
    const log = new InMemoryAuditLog();
    log.append('RISK_REJECTED', 'c1', {}, 1);
    log.append('RISK_APPROVED', 'c2', {}, 2);
    log.append('RISK_REJECTED', 'c3', {}, 3);

    expect(log.byType('RISK_REJECTED')).toHaveLength(2);
  });

  it("copies the payload so a later mutation of the caller's object cannot alter history", () => {
    const log = new InMemoryAuditLog();
    const payload = { quantity: 10 };
    const record = log.append('ORDER_STAGED', 'c', payload, 1);

    payload.quantity = 999;

    expect(record.payload.quantity).toBe(10);
    expect(log.verifyChain()).toBeNull();
  });
});
