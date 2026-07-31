/**
 * Indian equity transaction costs.
 *
 * Backtests that ignore costs are the single most common reason a strategy
 * looks profitable in research and loses money live: on NSE intraday, round
 * trips cost roughly 0.05–0.12% of turnover once brokerage, STT, exchange
 * charges, GST, SEBI fees and stamp duty are counted. A strategy with a 0.08%
 * per-trade edge is a losing strategy, and only a cost model shows that.
 *
 * Rates are the discount-broker schedule current at the time of writing;
 * they change by circular, so they are configuration rather than constants.
 */

import { mulRate, type Paise } from '../domain/money';
import type { ProductType, Side } from '../domain/types';

export interface CostSchedule {
  /** Percentage brokerage on turnover. */
  readonly brokerageRate: number;
  /** Per-order brokerage cap. Discount brokers charge min(rate × turnover, cap). */
  readonly brokerageCap: Paise;
  /** Securities Transaction Tax on the sell leg, intraday. */
  readonly sttIntradaySellRate: number;
  /** STT on both legs for delivery. */
  readonly sttDeliveryRate: number;
  /** NSE transaction charge on turnover. */
  readonly exchangeTransactionRate: number;
  /** GST on (brokerage + exchange charges + SEBI fees). */
  readonly gstRate: number;
  /** SEBI turnover fee. */
  readonly sebiTurnoverRate: number;
  /** Stamp duty, buy side only. */
  readonly stampDutyRate: number;
}

/** Discount-broker equity schedule. Verify against your broker before live trading. */
export const DEFAULT_COST_SCHEDULE: CostSchedule = {
  brokerageRate: 0.0003,
  brokerageCap: 2000 as Paise, // ₹20
  sttIntradaySellRate: 0.00025,
  sttDeliveryRate: 0.001,
  exchangeTransactionRate: 0.0000297,
  gstRate: 0.18,
  sebiTurnoverRate: 0.000001,
  stampDutyRate: 0.00015,
};

/** A zero schedule, for isolating strategy behaviour from cost drag in tests. */
export const ZERO_COST_SCHEDULE: CostSchedule = {
  brokerageRate: 0,
  brokerageCap: 0 as Paise,
  sttIntradaySellRate: 0,
  sttDeliveryRate: 0,
  exchangeTransactionRate: 0,
  gstRate: 0,
  sebiTurnoverRate: 0,
  stampDutyRate: 0,
};

export interface CostBreakdown {
  readonly brokerage: Paise;
  readonly stt: Paise;
  readonly exchangeCharges: Paise;
  readonly gst: Paise;
  readonly sebiCharges: Paise;
  readonly stampDuty: Paise;
  readonly total: Paise;
}

/**
 * Full cost of one execution.
 *
 * `CNC` is delivery (STT on both legs at the higher rate); `MIS`/`NRML` are
 * treated as intraday (STT on the sell leg only).
 */
export function computeCosts(
  turnover: Paise,
  side: Side,
  product: ProductType,
  schedule: CostSchedule = DEFAULT_COST_SCHEDULE,
): CostBreakdown {
  if (turnover < 0) throw new Error(`turnover must be non-negative, got ${turnover}`);

  const brokerage = Math.min(
    mulRate(turnover, schedule.brokerageRate),
    schedule.brokerageCap || Infinity,
  ) as Paise;

  const isDelivery = product === 'CNC';
  const stt = isDelivery
    ? mulRate(turnover, schedule.sttDeliveryRate)
    : side === 'SELL'
      ? mulRate(turnover, schedule.sttIntradaySellRate)
      : (0 as Paise);

  const exchangeCharges = mulRate(turnover, schedule.exchangeTransactionRate);
  const sebiCharges = mulRate(turnover, schedule.sebiTurnoverRate);
  const gst = mulRate((brokerage + exchangeCharges + sebiCharges) as Paise, schedule.gstRate);
  const stampDuty = side === 'BUY' ? mulRate(turnover, schedule.stampDutyRate) : (0 as Paise);

  const total = (brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty) as Paise;

  return { brokerage, stt, exchangeCharges, gst, sebiCharges, stampDuty, total };
}
