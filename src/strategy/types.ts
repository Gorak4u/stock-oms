/**
 * Strategy contract.
 *
 * Two properties are enforced by the shape of this interface:
 *
 * **No lookahead.** `evaluate` is given an `index` and may only read
 * `candles[0..index]`. Everything after that is the future. This is the single
 * most common way a backtest lies, and it is usually accidental — an indicator
 * computed over the whole array and then indexed at `i` has already seen the
 * end of the series.
 *
 * **Determinism.** Given the same candles and index, a strategy must return the
 * same signal. No wall clock, no randomness, no I/O. That is what makes a
 * backtest reproducible and a live decision explainable after the fact.
 *
 * The two-phase `prepare` / `evaluate` split exists so indicators are computed
 * once per series rather than once per bar, turning an O(n²) backtest into an
 * O(n) one — without tempting strategies to index into the future.
 */

import type { Candle, Position, Signal, Timestamp } from '../domain/types';
import type { Paise } from '../domain/money';

export interface StrategyContext {
  readonly symbol: string;
  /** Full series. Only indices `0..index` may be read. */
  readonly candles: readonly Candle[];
  /** Index of the bar being decided on. */
  readonly index: number;
  readonly position: Position | undefined;
  readonly now: Timestamp;
  /** Minutes until the session closes; 0 outside a session. */
  readonly minutesToClose: number;
}

export interface Strategy<P = unknown> {
  readonly id: string;
  /** Bars of history needed before signals are meaningful. */
  readonly warmupBars: number;
  /** Computes indicators once for the whole series. */
  prepare(candles: readonly Candle[]): P;
  /** Returns a signal for `ctx.index`, or `null` to do nothing. */
  evaluate(ctx: StrategyContext, prepared: P): Signal | null;
}

/** Builds a signal, clamping strength into [0, 1]. */
export function signal(
  params: Omit<Signal, 'strength'> & { strength: number },
): Signal {
  return { ...params, strength: Math.min(1, Math.max(0, params.strength)) };
}

/** Extracts a numeric field from candles for indicator input. */
export function closes(candles: readonly Candle[]): number[] {
  return candles.map((candle) => candle.close);
}

export function highs(candles: readonly Candle[]): number[] {
  return candles.map((candle) => candle.high);
}

export function lows(candles: readonly Candle[]): number[] {
  return candles.map((candle) => candle.low);
}

/** Current direction of a position, or `FLAT`. */
export function positionDirection(position: Position | undefined): 'LONG' | 'SHORT' | 'FLAT' {
  if (!position || position.quantity === 0) return 'FLAT';
  return position.quantity > 0 ? 'LONG' : 'SHORT';
}

export type { Paise };
