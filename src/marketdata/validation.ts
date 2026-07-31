/**
 * Market-data validation.
 *
 * A feed is an untrusted input. Bad ticks — a zero price during a session
 * rollover, a stale repeat, a fat-fingered print — reach the strategy layer as
 * genuine signals and the risk layer as genuine marks. Rejecting them here is
 * cheaper than unwinding the position they cause.
 */

import type { Candle, Tick, Timestamp } from '../domain/types';
import { ratio, type Paise } from '../domain/money';

export type RejectionCode =
  | 'NON_POSITIVE_PRICE'
  | 'NEGATIVE_QUANTITY'
  | 'CROSSED_QUOTE'
  | 'FUTURE_TIMESTAMP'
  | 'STALE_TIMESTAMP'
  | 'PRICE_SPIKE'
  | 'INCONSISTENT_OHLC'
  | 'NEGATIVE_VOLUME';

export interface ValidationResult {
  readonly valid: boolean;
  readonly rejections: readonly { code: RejectionCode; detail: string }[];
}

const OK: ValidationResult = { valid: true, rejections: [] };

function fail(rejections: { code: RejectionCode; detail: string }[]): ValidationResult {
  return { valid: rejections.length === 0, rejections };
}

export interface TickValidatorConfig {
  /**
   * Largest tolerated move from the previous accepted price, as a fraction.
   * NSE applies 10–20% price bands per scrip; 0.10 catches fat fingers while
   * still admitting a genuine limit-up move.
   */
  readonly maxMoveFraction?: number;
  /** How far ahead of the clock a timestamp may be, in ms — allows for clock skew. */
  readonly maxClockSkewMs?: number;
  /** Beyond this age a tick is stale and must not be used to mark a position. */
  readonly maxAgeMs?: number;
}

/**
 * Stateful per-symbol tick validator.
 *
 * Stateful because the interesting checks are relative: a price is only a
 * spike compared to the last good one.
 */
export class TickValidator {
  private lastGoodPrice: Paise | null = null;
  private lastGoodTimestamp: Timestamp | null = null;

  private readonly maxMoveFraction: number;
  private readonly maxClockSkewMs: number;
  private readonly maxAgeMs: number;

  constructor(config: TickValidatorConfig = {}) {
    this.maxMoveFraction = config.maxMoveFraction ?? 0.1;
    this.maxClockSkewMs = config.maxClockSkewMs ?? 5_000;
    this.maxAgeMs = config.maxAgeMs ?? 60_000;
  }

  /** Validates a tick against `now`. Accepted ticks advance the reference price. */
  validate(tick: Tick, now: Timestamp): ValidationResult {
    const rejections: { code: RejectionCode; detail: string }[] = [];

    if (tick.price <= 0) {
      rejections.push({ code: 'NON_POSITIVE_PRICE', detail: `price=${tick.price}` });
    }
    if (tick.quantity < 0) {
      rejections.push({ code: 'NEGATIVE_QUANTITY', detail: `quantity=${tick.quantity}` });
    }
    if (tick.bid !== undefined && tick.ask !== undefined && tick.bid > tick.ask) {
      rejections.push({ code: 'CROSSED_QUOTE', detail: `bid=${tick.bid} ask=${tick.ask}` });
    }
    if (tick.timestamp > now + this.maxClockSkewMs) {
      rejections.push({
        code: 'FUTURE_TIMESTAMP',
        detail: `timestamp=${tick.timestamp} now=${now}`,
      });
    }
    if (tick.timestamp < now - this.maxAgeMs) {
      rejections.push({
        code: 'STALE_TIMESTAMP',
        detail: `age=${now - tick.timestamp}ms exceeds ${this.maxAgeMs}ms`,
      });
    }

    if (this.lastGoodPrice !== null && tick.price > 0) {
      const move = Math.abs(ratio(tick.price, this.lastGoodPrice) - 1);
      if (move > this.maxMoveFraction) {
        rejections.push({
          code: 'PRICE_SPIKE',
          detail: `moved ${(move * 100).toFixed(2)}% from ${this.lastGoodPrice}`,
        });
      }
    }

    const result = fail(rejections);
    if (result.valid) {
      this.lastGoodPrice = tick.price;
      this.lastGoodTimestamp = tick.timestamp;
    }
    return result;
  }

  /**
   * True when no fresh tick has arrived within `maxAgeMs`.
   *
   * The execution layer treats a stale symbol as untradeable — marking a
   * position against a price that stopped updating is how a stop-loss silently
   * stops working.
   */
  isStale(now: Timestamp): boolean {
    if (this.lastGoodTimestamp === null) return true;
    return now - this.lastGoodTimestamp > this.maxAgeMs;
  }

  get referencePrice(): Paise | null {
    return this.lastGoodPrice;
  }
}

/** Checks a candle's internal consistency. Stateless. */
export function validateCandle(candle: Candle): ValidationResult {
  const rejections: { code: RejectionCode; detail: string }[] = [];

  if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0) {
    rejections.push({
      code: 'NON_POSITIVE_PRICE',
      detail: `o=${candle.open} h=${candle.high} l=${candle.low} c=${candle.close}`,
    });
  }
  if (candle.volume < 0) {
    rejections.push({ code: 'NEGATIVE_VOLUME', detail: `volume=${candle.volume}` });
  }

  const maxBody = Math.max(candle.open, candle.close);
  const minBody = Math.min(candle.open, candle.close);
  if (candle.high < maxBody || candle.low > minBody || candle.high < candle.low) {
    rejections.push({
      code: 'INCONSISTENT_OHLC',
      detail: `high=${candle.high} low=${candle.low} must bracket open=${candle.open} close=${candle.close}`,
    });
  }

  return fail(rejections);
}

/** Filters a series to the candles that pass {@link validateCandle}. */
export function sanitiseCandles(candles: readonly Candle[]): {
  accepted: Candle[];
  rejected: { candle: Candle; result: ValidationResult }[];
} {
  const accepted: Candle[] = [];
  const rejected: { candle: Candle; result: ValidationResult }[] = [];

  for (const candle of candles) {
    const result = validateCandle(candle);
    if (result.valid) accepted.push(candle);
    else rejected.push({ candle, result });
  }

  return { accepted, rejected };
}

export { OK as VALID };
