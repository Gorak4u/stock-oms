/**
 * The risk engine — the last checkpoint before an order reaches a broker.
 *
 * Two rules shape the whole design:
 *
 * 1. **Risk-reducing orders are never blocked.** Every control here can stop
 *    an order that opens or increases exposure. None of them may stop an order
 *    that closes it. A control that traps the account in a losing position
 *    while the market moves against it is worse than no control at all — this
 *    is the failure mode behind most "the risk system made it worse" stories.
 *
 * 2. **State controls reject; size controls scale.** Breached drawdown, a
 *    tripped breaker or an engaged kill switch mean the system should not be
 *    opening risk at all, so those reject outright. Exposure and concentration
 *    caps are about magnitude, so they reduce the quantity instead.
 */

import type { Position } from '../domain/types';
import { abs, mulRate, ratio, sum, type Paise } from '../domain/money';
import {
  type AccountState,
  type RiskContext,
  type RiskDecision,
  type RiskLimits,
  type RiskRejection,
  DEFAULT_RISK_LIMITS,
} from './types';

const ONE_MINUTE_MS = 60_000;

export interface ExposureSnapshot {
  /** Long + |short|. */
  readonly gross: Paise;
  /** Long − |short|. */
  readonly net: Paise;
  readonly bySymbol: Readonly<Record<string, Paise>>;
  readonly openPositions: number;
}

export function computeExposure(positions: readonly Position[]): ExposureSnapshot {
  const bySymbol: Record<string, Paise> = {};
  let gross = 0;
  let net = 0;
  let openPositions = 0;

  for (const position of positions) {
    if (position.quantity === 0) continue;
    openPositions += 1;

    const signed = position.quantity * position.lastPrice;
    gross += Math.abs(signed);
    net += signed;

    const existing = bySymbol[position.symbol] ?? 0;
    bySymbol[position.symbol] = (existing + Math.abs(signed)) as Paise;
  }

  return {
    gross: gross as Paise,
    net: net as Paise,
    bySymbol,
    openPositions,
  };
}

/**
 * True when the order moves the position toward flat.
 *
 * A BUY against a short position and a SELL against a long one both reduce
 * risk. Quantity beyond what is needed to flatten would flip the position and
 * open new risk, so only the flattening portion is treated as reducing.
 */
export function reducingQuantity(
  request: { symbol: string; side: 'BUY' | 'SELL'; quantity: number },
  positions: readonly Position[],
): number {
  const position = positions.find((candidate) => candidate.symbol === request.symbol);
  if (!position || position.quantity === 0) return 0;

  const isLong = position.quantity > 0;
  const closes = (isLong && request.side === 'SELL') || (!isLong && request.side === 'BUY');
  if (!closes) return 0;

  return Math.min(request.quantity, Math.abs(position.quantity));
}

/**
 * Emergency stop.
 *
 * Engaging it blocks every risk-increasing order across the platform until a
 * human clears it. Kept as an explicit object rather than a boolean so the
 * reason and the time survive into the audit log.
 */
export class KillSwitch {
  private engagedAt: number | null = null;
  private reason = '';

  engage(reason: string, at: number): void {
    if (this.engagedAt !== null) return;
    this.engagedAt = at;
    this.reason = reason;
  }

  /** Clearing is deliberately manual — nothing in the system re-enables trading on its own. */
  release(): void {
    this.engagedAt = null;
    this.reason = '';
  }

  get isEngaged(): boolean {
    return this.engagedAt !== null;
  }

  get state(): { engaged: boolean; reason: string; since: number | null } {
    return { engaged: this.engagedAt !== null, reason: this.reason, since: this.engagedAt };
  }
}

/**
 * Consecutive-loss circuit breaker.
 *
 * Counts losing trades in a row and trips at the configured threshold. The
 * trip is a *cooling-off period*, not a latch: once `cooldownMs` has elapsed
 * the streak is cleared and trading resumes.
 *
 * The distinction matters more than it looks. A losing streak is cleared by a
 * winning trade — so a breaker that blocks all entries and only resets on a win
 * can never reset. It would trip once, early, and silently disable the system
 * for the rest of its life while every dashboard showed it running normally.
 */
export class LossStreakBreaker {
  private streak = 0;
  private trippedAt: number | null = null;

  constructor(
    private readonly maxConsecutiveLosses: number,
    private readonly cooldownMs: number,
  ) {}

  /** Records a closed trade's outcome. */
  record(pnl: number, now: number): void {
    if (pnl < 0) {
      this.streak += 1;
      if (this.streak >= this.maxConsecutiveLosses && this.trippedAt === null) {
        this.trippedAt = now;
      }
      return;
    }
    this.streak = 0;
    this.trippedAt = null;
  }

  /**
   * The streak as the risk engine should see it.
   *
   * Returns 0 once the cooling-off period has elapsed, which is what actually
   * releases the breaker.
   */
  effectiveStreak(now: number): number {
    if (this.trippedAt !== null && now - this.trippedAt >= this.cooldownMs) {
      this.streak = 0;
      this.trippedAt = null;
    }
    return this.streak;
  }

  isTripped(now: number): boolean {
    return this.effectiveStreak(now) >= this.maxConsecutiveLosses;
  }

  get state(): { streak: number; trippedAt: number | null } {
    return { streak: this.streak, trippedAt: this.trippedAt };
  }
}

export class RiskEngine {
  readonly killSwitch: KillSwitch;

  constructor(
    private readonly limits: RiskLimits = DEFAULT_RISK_LIMITS,
    killSwitch: KillSwitch = new KillSwitch(),
  ) {
    this.killSwitch = killSwitch;
    validateLimits(limits);
  }

  /**
   * Judges one order against the full control set.
   *
   * Runs every check rather than short-circuiting on the first failure: an
   * operator looking at a rejected order wants all the reasons at once, not
   * whichever happened to be evaluated first.
   */
  evaluate(context: RiskContext, account: AccountState): RiskDecision {
    const { request, referencePrice, now } = context;
    const rejections: RiskRejection[] = [];
    const adjustments: string[] = [];

    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      return reject([
        { code: 'INVALID_QUANTITY', detail: `quantity=${request.quantity}` },
      ]);
    }
    if (referencePrice <= 0) {
      return reject([
        { code: 'INVALID_QUANTITY', detail: `referencePrice=${referencePrice}` },
      ]);
    }

    const reducing = reducingQuantity(request, account.positions);
    const isPureReduction = reducing >= request.quantity;

    // Risk-reducing orders bypass every control except data quality: filling a
    // close against a stale price is the one way a "safe" order still hurts.
    if (isPureReduction) {
      if (context.dataIsStale) {
        return reject([
          { code: 'STALE_MARKET_DATA', detail: `no fresh price for ${request.symbol}` },
        ]);
      }
      return {
        approved: true,
        approvedQuantity: request.quantity,
        rejections: [],
        adjustments: ['risk-reducing order — size controls bypassed'],
      };
    }

    // --- State controls: these reject, they never resize. --------------------

    if (this.killSwitch.isEngaged) {
      rejections.push({
        code: 'KILL_SWITCH_ENGAGED',
        detail: this.killSwitch.state.reason || 'emergency stop active',
      });
    }
    if (!context.marketOpen) {
      rejections.push({ code: 'MARKET_CLOSED', detail: `no session at ${now}` });
    }
    if (context.dataIsStale) {
      rejections.push({
        code: 'STALE_MARKET_DATA',
        detail: `no fresh price for ${request.symbol}`,
      });
    }
    if (this.limits.requireStopLoss && context.stopLoss === undefined) {
      rejections.push({
        code: 'MISSING_STOP_LOSS',
        detail: `${request.strategyId} submitted an entry with no protective stop`,
      });
    }

    const dailyLossLimit = mulRate(account.startOfDayEquity, this.limits.dailyLossLimitFraction);
    if (account.dayPnl < 0 && abs(account.dayPnl) >= dailyLossLimit) {
      rejections.push({
        code: 'DAILY_LOSS_LIMIT',
        detail: `day P&L ${account.dayPnl} breached limit ${-dailyLossLimit}`,
      });
    }

    if (account.peakEquity > 0) {
      const drawdown = 1 - ratio(account.equity, account.peakEquity);
      if (drawdown >= this.limits.maxDrawdownFraction) {
        rejections.push({
          code: 'MAX_DRAWDOWN',
          detail: `drawdown ${(drawdown * 100).toFixed(2)}% at or beyond ${(
            this.limits.maxDrawdownFraction * 100
          ).toFixed(2)}%`,
        });
      }
    }

    if (account.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
      rejections.push({
        code: 'CONSECUTIVE_LOSS_BREAKER',
        detail: `${account.consecutiveLosses} consecutive losses`,
      });
    }

    const recentOrders = account.recentOrderTimestamps.filter(
      (timestamp) => now - timestamp < ONE_MINUTE_MS,
    ).length;
    if (recentOrders >= this.limits.maxOrdersPerMinute) {
      rejections.push({
        code: 'ORDER_RATE_BREAKER',
        detail: `${recentOrders} orders in the last minute`,
      });
    }

    const exposure = computeExposure(account.positions);
    const isNewSymbol = !exposure.bySymbol[request.symbol];
    if (isNewSymbol && exposure.openPositions >= this.limits.maxOpenPositions) {
      rejections.push({
        code: 'MAX_OPEN_POSITIONS',
        detail: `${exposure.openPositions} already open`,
      });
    }

    if (rejections.length > 0) return reject(rejections);

    // --- Size controls: these scale the order down. --------------------------

    let quantity = request.quantity;
    const capBySymbolValue = (cap: Paise, label: string): void => {
      const maxQuantity = Math.floor(cap / referencePrice);
      if (maxQuantity < quantity) {
        adjustments.push(`${label}: ${quantity} → ${Math.max(0, maxQuantity)}`);
        quantity = Math.max(0, maxQuantity);
      }
    };

    const equity = account.equity;

    capBySymbolValue(mulRate(equity, this.limits.maxPositionFraction), 'max position value');

    const symbolExposure = exposure.bySymbol[request.symbol] ?? (0 as Paise);
    const symbolHeadroom = Math.max(
      0,
      mulRate(equity, this.limits.maxSymbolConcentrationFraction) - symbolExposure,
    ) as Paise;
    capBySymbolValue(symbolHeadroom, 'symbol concentration');

    const grossHeadroom = Math.max(
      0,
      mulRate(equity, this.limits.maxGrossExposureFraction) - exposure.gross,
    ) as Paise;
    capBySymbolValue(grossHeadroom, 'gross exposure');

    // Net exposure is directional: a BUY consumes headroom on the long side,
    // a SELL on the short side.
    const netCap = mulRate(equity, this.limits.maxNetExposureFraction);
    const netHeadroom = Math.max(
      0,
      request.side === 'BUY' ? netCap - exposure.net : netCap + exposure.net,
    ) as Paise;
    capBySymbolValue(netHeadroom, 'net exposure');

    const allocation = account.strategyAllocations?.[request.strategyId];
    if (allocation !== undefined) {
      const used = account.strategyExposure?.[request.strategyId] ?? (0 as Paise);
      const headroom = Math.max(0, allocation - used) as Paise;
      capBySymbolValue(headroom, `strategy allocation (${request.strategyId})`);
    }

    // Cash last: whatever the other caps allow, the account still has to pay.
    capBySymbolValue(account.availableCash, 'available cash');

    if (quantity <= 0) {
      const code = pickBindingCode(adjustments);
      return reject([
        { code, detail: `all size controls reduced the order to zero (${adjustments.join('; ')})` },
      ]);
    }

    return { approved: true, approvedQuantity: quantity, rejections: [], adjustments };
  }

  /**
   * Session-level halt check, independent of any particular order.
   *
   * The monitoring loop calls this on every equity update so the kill switch
   * engages the moment a limit is breached, rather than on the next order.
   */
  checkHaltConditions(account: AccountState, now: number): RiskRejection[] {
    const breaches: RiskRejection[] = [];

    const dailyLossLimit = mulRate(account.startOfDayEquity, this.limits.dailyLossLimitFraction);
    if (account.dayPnl < 0 && abs(account.dayPnl) >= dailyLossLimit) {
      breaches.push({
        code: 'DAILY_LOSS_LIMIT',
        detail: `day P&L ${account.dayPnl} breached ${-dailyLossLimit}`,
      });
    }

    if (account.peakEquity > 0) {
      const drawdown = 1 - ratio(account.equity, account.peakEquity);
      if (drawdown >= this.limits.maxDrawdownFraction) {
        breaches.push({
          code: 'MAX_DRAWDOWN',
          detail: `drawdown ${(drawdown * 100).toFixed(2)}%`,
        });
      }
    }

    if (breaches.length > 0 && !this.killSwitch.isEngaged) {
      this.killSwitch.engage(breaches.map((breach) => breach.detail).join('; '), now);
    }

    return breaches;
  }

  get configuredLimits(): RiskLimits {
    return this.limits;
  }
}

function reject(rejections: RiskRejection[]): RiskDecision {
  return { approved: false, approvedQuantity: 0, rejections, adjustments: [] };
}

/** Maps the last applied size control back to the rejection code that describes it. */
function pickBindingCode(adjustments: readonly string[]): RiskRejection['code'] {
  const last = adjustments[adjustments.length - 1] ?? '';
  if (last.startsWith('available cash')) return 'INSUFFICIENT_CAPITAL';
  if (last.startsWith('strategy allocation')) return 'STRATEGY_ALLOCATION_EXCEEDED';
  if (last.startsWith('net exposure')) return 'MAX_NET_EXPOSURE';
  if (last.startsWith('gross exposure')) return 'MAX_GROSS_EXPOSURE';
  if (last.startsWith('symbol concentration')) return 'MAX_SYMBOL_CONCENTRATION';
  return 'MAX_POSITION_VALUE';
}

function validateLimits(limits: RiskLimits): void {
  const fractions: [keyof RiskLimits, number][] = [
    ['riskPerTradeFraction', limits.riskPerTradeFraction],
    ['maxPositionFraction', limits.maxPositionFraction],
    ['maxGrossExposureFraction', limits.maxGrossExposureFraction],
    ['maxNetExposureFraction', limits.maxNetExposureFraction],
    ['maxSymbolConcentrationFraction', limits.maxSymbolConcentrationFraction],
    ['dailyLossLimitFraction', limits.dailyLossLimitFraction],
    ['maxDrawdownFraction', limits.maxDrawdownFraction],
  ];

  for (const [name, value] of fractions) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`risk limit ${String(name)} must be a positive fraction, got ${value}`);
    }
  }
  if (limits.maxOpenPositions < 1) {
    throw new Error('maxOpenPositions must be at least 1');
  }
}

export { sum };
