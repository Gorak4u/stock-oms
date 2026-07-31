/**
 * Momentum — Donchian channel breakout confirmed by rate of change.
 *
 * The breakout level is taken from the window *ending at the previous bar*.
 * Including the current bar makes the channel high trivially equal to today's
 * high on every up day, so "price broke out" becomes a tautology and the
 * backtest shows an edge that does not exist. This off-by-one is the classic
 * Donchian implementation bug.
 */

import type { Candle } from '../domain/types';
import { atr, highest, lowest, roc, type IndicatorSeries } from '../features/indicators';
import { atrStopLoss } from '../risk/positionSizing';
import {
  closes,
  highs,
  lows,
  positionDirection,
  signal,
  type Strategy,
  type StrategyContext,
} from './types';

export interface MomentumConfig {
  /** Breakout channel length. */
  readonly channelPeriod?: number;
  /** Shorter channel used as the trailing exit. */
  readonly exitChannelPeriod?: number;
  readonly rocPeriod?: number;
  /** Minimum rate of change, as a fraction, confirming the breakout. */
  readonly minRoc?: number;
  readonly atrPeriod?: number;
  readonly atrStopMultiplier?: number;
  /** Allow short breakouts. Off by default — many cash accounts cannot short. */
  readonly allowShorts?: boolean;
}

interface Prepared {
  readonly upper: IndicatorSeries;
  readonly lower: IndicatorSeries;
  readonly exitUpper: IndicatorSeries;
  readonly exitLower: IndicatorSeries;
  readonly rocValues: IndicatorSeries;
  readonly atrValues: IndicatorSeries;
}

export class MomentumStrategy implements Strategy<Prepared> {
  readonly id: string;
  readonly warmupBars: number;

  private readonly channelPeriod: number;
  private readonly exitChannelPeriod: number;
  private readonly rocPeriod: number;
  private readonly minRoc: number;
  private readonly atrPeriod: number;
  private readonly atrStopMultiplier: number;
  private readonly allowShorts: boolean;

  constructor(config: MomentumConfig = {}, id = 'momentum') {
    this.channelPeriod = config.channelPeriod ?? 55;
    this.exitChannelPeriod = config.exitChannelPeriod ?? 20;
    this.rocPeriod = config.rocPeriod ?? 20;
    this.minRoc = config.minRoc ?? 0.02;
    this.atrPeriod = config.atrPeriod ?? 14;
    this.atrStopMultiplier = config.atrStopMultiplier ?? 3;
    this.allowShorts = config.allowShorts ?? false;

    if (this.exitChannelPeriod >= this.channelPeriod) {
      throw new Error('momentum exit channel must be shorter than the entry channel');
    }

    this.id = id;
    this.warmupBars = Math.max(this.channelPeriod, this.rocPeriod, this.atrPeriod) + 2;
  }

  prepare(candles: readonly Candle[]): Prepared {
    const close = closes(candles);
    const high = highs(candles);
    const low = lows(candles);

    return {
      upper: highest(high, this.channelPeriod),
      lower: lowest(low, this.channelPeriod),
      exitUpper: highest(high, this.exitChannelPeriod),
      exitLower: lowest(low, this.exitChannelPeriod),
      rocValues: roc(close, this.rocPeriod),
      atrValues: atr({ high, low, close }, this.atrPeriod),
    };
  }

  evaluate(ctx: StrategyContext, prepared: Prepared) {
    const { index } = ctx;
    if (index < this.warmupBars) return null;

    // Channels are read at index - 1: the level must be known before the bar
    // that breaks it. See the file comment.
    const previous = index - 1;
    const upper = prepared.upper[previous];
    const lower = prepared.lower[previous];
    const exitUpper = prepared.exitUpper[previous];
    const exitLower = prepared.exitLower[previous];
    const rocValue = prepared.rocValues[index];
    const atrValue = prepared.atrValues[index];

    if (
      upper == null ||
      lower == null ||
      exitUpper == null ||
      exitLower == null ||
      rocValue == null ||
      atrValue == null ||
      atrValue <= 0
    ) {
      return null;
    }

    const candle = ctx.candles[index]!;
    const price = candle.close;
    const held = positionDirection(ctx.position);

    if (held === 'LONG' && price < exitLower) {
      return signal({
        symbol: ctx.symbol,
        strategyId: this.id,
        direction: 'FLAT',
        strength: 1,
        timestamp: candle.timestamp,
        referencePrice: price,
        rationale: `closed below the ${this.exitChannelPeriod}-bar low — momentum exhausted`,
      });
    }
    if (held === 'SHORT' && price > exitUpper) {
      return signal({
        symbol: ctx.symbol,
        strategyId: this.id,
        direction: 'FLAT',
        strength: 1,
        timestamp: candle.timestamp,
        referencePrice: price,
        rationale: `closed above the ${this.exitChannelPeriod}-bar high — momentum exhausted`,
      });
    }

    if (held !== 'FLAT') return null;

    const brokeUp = price > upper && rocValue >= this.minRoc;
    const brokeDown = this.allowShorts && price < lower && rocValue <= -this.minRoc;
    if (!brokeUp && !brokeDown) return null;

    const direction = brokeUp ? 'LONG' : 'SHORT';
    const strength = Math.min(1, Math.abs(rocValue) / (this.minRoc * 3));

    return signal({
      symbol: ctx.symbol,
      strategyId: this.id,
      direction,
      strength,
      timestamp: candle.timestamp,
      referencePrice: price,
      stopLoss: atrStopLoss(price, atrValue, direction, this.atrStopMultiplier),
      rationale:
        `broke the ${this.channelPeriod}-bar ${brokeUp ? 'high' : 'low'} ` +
        `with ${(rocValue * 100).toFixed(2)}% ${this.rocPeriod}-bar momentum`,
    });
  }
}
