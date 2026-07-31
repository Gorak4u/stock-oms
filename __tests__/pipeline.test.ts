import { fromRupees, type Paise } from '../src/domain/money';
import type { Candle, Signal } from '../src/domain/types';
import { InMemoryAuditLog } from '../src/audit/log';
import { MarketCalendar, fromIst } from '../src/marketdata/calendar';
import { PaperBroker } from '../src/execution/paperBroker';
import { ZERO_COST_SCHEDULE } from '../src/execution/costs';
import { OrderManager } from '../src/execution/oms';
import { Portfolio } from '../src/execution/portfolio';
import { RiskEngine } from '../src/risk/engine';
import { DEFAULT_RISK_LIMITS } from '../src/risk/types';
import { signal, type Strategy, type StrategyContext } from '../src/strategy/types';
import { TradingPipeline } from '../src/pipeline/tradingPipeline';

/** Emits a LONG entry on every bar past warm-up, so mode handling is what varies. */
class AlwaysEnter implements Strategy<null> {
  readonly id = 'always-enter';
  readonly warmupBars = 0;

  prepare(): null {
    return null;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const candle = ctx.candles[ctx.index]!;
    if (ctx.position && ctx.position.quantity !== 0) return null;

    return signal({
      symbol: ctx.symbol,
      strategyId: this.id,
      direction: 'LONG',
      strength: 1,
      timestamp: candle.timestamp,
      referencePrice: candle.close,
      stopLoss: (candle.close - fromRupees(20)) as Paise,
      rationale: 'test entry',
    });
  }
}

const SESSION_MINUTE = 10 * 60; // 10:00 IST, inside the session

function bars(count: number, day = '2026-03-02'): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const price = 1000 + i;
    return {
      symbol: 'NSE:TEST',
      interval: '1m' as const,
      timestamp: fromIst(day, SESSION_MINUTE + i),
      open: fromRupees(price),
      high: fromRupees(price + 2),
      low: fromRupees(price - 2),
      close: fromRupees(price),
      volume: 10_000,
    };
  });
}

function build(mode: 'MANUAL' | 'APPROVAL' | 'AUTOMATIC') {
  const audit = new InMemoryAuditLog();
  const portfolio = new Portfolio(fromRupees(1_000_000));
  const broker = new PaperBroker({ slippageFraction: 0, costSchedule: ZERO_COST_SCHEDULE });
  const oms = new OrderManager({ broker, audit, clock: () => fromIst('2026-03-02', SESSION_MINUTE) });
  const risk = new RiskEngine(DEFAULT_RISK_LIMITS);
  const calendar = new MarketCalendar({ holidays: [] });

  const pipeline = new TradingPipeline({
    strategy: new AlwaysEnter(),
    risk,
    oms,
    portfolio,
    calendar,
    audit,
    limits: DEFAULT_RISK_LIMITS,
    mode,
  });

  return { pipeline, audit, portfolio, risk, oms, broker };
}

describe('TradingPipeline — automation modes', () => {
  it('submits straight through in AUTOMATIC mode', async () => {
    const { pipeline } = build('AUTOMATIC');
    const outcome = await pipeline.onBar('NSE:TEST', bars(5));

    expect(outcome.kind).toBe('SUBMITTED');
  });

  it('stages for approval in APPROVAL mode instead of sending', async () => {
    const { pipeline } = build('APPROVAL');
    const outcome = await pipeline.onBar('NSE:TEST', bars(5));

    expect(outcome.kind).toBe('AWAITING_APPROVAL');
    expect(pipeline.pendingApprovals()).toHaveLength(1);
  });

  it('stages in MANUAL mode too — nothing reaches the broker unattended', async () => {
    const { pipeline } = build('MANUAL');
    const outcome = await pipeline.onBar('NSE:TEST', bars(5));

    expect(outcome.kind).toBe('AWAITING_APPROVAL');
  });

  it('sends a staged order once approved', async () => {
    const { pipeline } = build('APPROVAL');
    const staged = await pipeline.onBar('NSE:TEST', bars(5));
    if (staged.kind !== 'AWAITING_APPROVAL') throw new Error('expected a staged order');

    const outcome = await pipeline.approve(
      staged.request.idempotencyKey,
      fromIst('2026-03-02', SESSION_MINUTE),
    );

    expect(outcome.kind).toBe('SUBMITTED');
    expect(pipeline.pendingApprovals()).toHaveLength(0);
  });

  it('re-checks risk at approval time and refuses a stale decision', async () => {
    const { pipeline, risk } = build('APPROVAL');
    const staged = await pipeline.onBar('NSE:TEST', bars(5));
    if (staged.kind !== 'AWAITING_APPROVAL') throw new Error('expected a staged order');

    // The world moved on between staging and approval.
    risk.killSwitch.engage('operator halted trading', 1);

    const outcome = await pipeline.approve(
      staged.request.idempotencyKey,
      fromIst('2026-03-02', SESSION_MINUTE),
    );

    expect(outcome.kind).toBe('RISK_REJECTED');
  });

  it('drops a rejected approval', async () => {
    const { pipeline, audit } = build('APPROVAL');
    const staged = await pipeline.onBar('NSE:TEST', bars(5));
    if (staged.kind !== 'AWAITING_APPROVAL') throw new Error('expected a staged order');

    pipeline.reject(staged.request.idempotencyKey, 1, 'operator declined');

    expect(pipeline.pendingApprovals()).toHaveLength(0);
    expect(audit.byType('ORDER_CANCELLED')).toHaveLength(1);
  });

  it('audits a mode change', () => {
    const { pipeline, audit } = build('MANUAL');
    pipeline.setMode('AUTOMATIC', 123, 'alice');

    expect(pipeline.automationMode).toBe('AUTOMATIC');
    const record = audit.byType('MODE_CHANGED')[0]!;
    expect(record.payload).toMatchObject({ previous: 'MANUAL', mode: 'AUTOMATIC', actor: 'alice' });
  });
});

describe('TradingPipeline — safety', () => {
  it('blocks new orders once the emergency stop is engaged', async () => {
    const { pipeline } = build('AUTOMATIC');
    pipeline.emergencyStop('operator pulled the plug', 1);

    const outcome = await pipeline.onBar('NSE:TEST', bars(5));
    expect(outcome.kind).toBe('RISK_REJECTED');
    if (outcome.kind === 'RISK_REJECTED') {
      expect(outcome.reasons.join(' ')).toContain('KILL_SWITCH_ENGAGED');
    }
  });

  it('resumes only after an explicit release', async () => {
    const { pipeline } = build('AUTOMATIC');
    pipeline.emergencyStop('halt', 1);
    pipeline.releaseEmergencyStop(2);

    const outcome = await pipeline.onBar('NSE:TEST', bars(5));
    expect(outcome.kind).toBe('SUBMITTED');
  });

  it('audits engaging and releasing the emergency stop', () => {
    const { pipeline, audit } = build('AUTOMATIC');
    pipeline.emergencyStop('halt', 1);
    pipeline.releaseEmergencyStop(2, 'bob');

    expect(audit.byType('KILL_SWITCH_ENGAGED')).toHaveLength(1);
    expect(audit.byType('KILL_SWITCH_RELEASED')).toHaveLength(1);
  });

  it('refuses to trade outside a session', async () => {
    const { pipeline } = build('AUTOMATIC');
    // 03:00 IST — long before the open.
    const nightBars = bars(5).map((candle, i) => ({
      ...candle,
      timestamp: fromIst('2026-03-02', 3 * 60 + i),
    }));

    const outcome = await pipeline.onBar('NSE:TEST', nightBars);
    expect(outcome.kind).toBe('RISK_REJECTED');
    if (outcome.kind === 'RISK_REJECTED') {
      expect(outcome.reasons.join(' ')).toContain('MARKET_CLOSED');
    }
  });

  it('writes an intact audit trail for a full signal-to-submit journey', async () => {
    const { pipeline, audit } = build('AUTOMATIC');
    await pipeline.onBar('NSE:TEST', bars(5));

    expect(audit.verifyChain()).toBeNull();
    expect(audit.byType('SIGNAL_GENERATED').length).toBeGreaterThan(0);
    expect(audit.byType('RISK_APPROVED').length).toBeGreaterThan(0);
    expect(audit.byType('ORDER_SUBMITTED').length).toBeGreaterThan(0);
  });

  it('does not re-enter a symbol it already holds', async () => {
    const { pipeline, portfolio } = build('AUTOMATIC');
    portfolio.applyFill({
      orderId: 'seed',
      symbol: 'NSE:TEST',
      side: 'BUY',
      quantity: 10,
      price: fromRupees(1000),
      timestamp: 0,
      commission: 0 as Paise,
    });

    const outcome = await pipeline.onBar('NSE:TEST', bars(5));
    expect(outcome.kind).toBe('NO_SIGNAL');
  });

  it('reports an unknown approval key rather than throwing', async () => {
    const { pipeline } = build('APPROVAL');
    const outcome = await pipeline.approve('nonexistent', 1);
    expect(outcome.kind).toBe('NO_SIGNAL');
  });
});
