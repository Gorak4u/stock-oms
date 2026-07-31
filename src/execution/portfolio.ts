/**
 * Portfolio accounting — positions, cash and P&L.
 *
 * The single source of truth for "what do we own and what is it worth". Every
 * mutation goes through {@link Portfolio.applyFill}, so the equity curve is a
 * pure function of the fill sequence and can be rebuilt exactly from the audit
 * log after a crash.
 *
 * Positions are signed: positive is long, negative is short. Handling both
 * with one sign convention avoids a second code path for shorts, which is
 * where P&L sign errors usually hide.
 */

import type { Fill, Position, Timestamp } from '../domain/types';
import { fromPaise, type Paise } from '../domain/money';

interface MutablePosition {
  symbol: string;
  quantity: number;
  averagePrice: Paise;
  realisedPnl: Paise;
  lastPrice: Paise;
}

export interface PortfolioSnapshot {
  readonly cash: Paise;
  readonly equity: Paise;
  readonly positions: readonly Position[];
  readonly realisedPnl: Paise;
  readonly unrealisedPnl: Paise;
  readonly totalCommission: Paise;
}

/** A round-trip, recorded when a position's closing quantity is filled. */
export interface ClosedTrade {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly quantity: number;
  readonly entryPrice: Paise;
  readonly exitPrice: Paise;
  /** Net of the commission on the closing fill. */
  readonly pnl: Paise;
  readonly closedAt: Timestamp;
}

export class Portfolio {
  private cashBalance: Paise;
  private readonly positions = new Map<string, MutablePosition>();
  private commissionPaid: Paise = 0 as Paise;
  private readonly trades: ClosedTrade[] = [];

  constructor(openingCash: Paise) {
    if (openingCash < 0) throw new Error(`opening cash must be non-negative, got ${openingCash}`);
    this.cashBalance = openingCash;
  }

  /**
   * Applies a fill.
   *
   * Four cases: opening from flat, adding to a position, reducing one, and
   * reversing through zero. The reversal case is the subtle one — the closing
   * portion realises P&L against the old average, and only the surplus opens
   * the new position, at the fill price.
   */
  applyFill(fill: Fill): ClosedTrade | null {
    if (fill.quantity <= 0) throw new Error(`fill quantity must be positive, got ${fill.quantity}`);

    const signedQuantity = fill.side === 'BUY' ? fill.quantity : -fill.quantity;
    const grossValue = fill.quantity * fill.price;

    // Cash moves opposite to the position, and commission always leaves.
    this.cashBalance = fromPaise(
      this.cashBalance + (fill.side === 'BUY' ? -grossValue : grossValue) - fill.commission,
    );
    this.commissionPaid = fromPaise(this.commissionPaid + fill.commission);

    const existing = this.positions.get(fill.symbol) ?? {
      symbol: fill.symbol,
      quantity: 0,
      averagePrice: 0 as Paise,
      realisedPnl: 0 as Paise,
      lastPrice: fill.price,
    };
    existing.lastPrice = fill.price;

    const previousQuantity = existing.quantity;
    const newQuantity = previousQuantity + signedQuantity;
    let closed: ClosedTrade | null = null;

    const isOpeningOrAdding =
      previousQuantity === 0 || Math.sign(previousQuantity) === Math.sign(signedQuantity);

    if (isOpeningOrAdding) {
      const totalCost = previousQuantity * existing.averagePrice + signedQuantity * fill.price;
      existing.averagePrice = fromPaise(
        newQuantity === 0 ? 0 : Math.round(totalCost / newQuantity),
      );
      existing.quantity = newQuantity;
    } else {
      const closingQuantity = Math.min(Math.abs(signedQuantity), Math.abs(previousQuantity));
      const direction: 'LONG' | 'SHORT' = previousQuantity > 0 ? 'LONG' : 'SHORT';

      // Long profits when the exit is above the average; short is the mirror.
      const perShare =
        direction === 'LONG'
          ? fill.price - existing.averagePrice
          : existing.averagePrice - fill.price;
      const grossPnl = perShare * closingQuantity;
      const netPnl = fromPaise(grossPnl - fill.commission);

      existing.realisedPnl = fromPaise(existing.realisedPnl + netPnl);
      closed = {
        symbol: fill.symbol,
        direction,
        quantity: closingQuantity,
        entryPrice: existing.averagePrice,
        exitPrice: fill.price,
        pnl: netPnl,
        closedAt: fill.timestamp,
      };
      this.trades.push(closed);

      existing.quantity = newQuantity;
      if (newQuantity === 0) {
        existing.averagePrice = 0 as Paise;
      } else if (Math.sign(newQuantity) !== Math.sign(previousQuantity)) {
        // Reversed through zero — the surplus is a fresh position at fill price.
        existing.averagePrice = fill.price;
      }
    }

    this.positions.set(fill.symbol, existing);
    return closed;
  }

  /** Updates the mark used for unrealised P&L and equity. */
  mark(symbol: string, price: Paise): void {
    const position = this.positions.get(symbol);
    if (position) position.lastPrice = price;
  }

  markAll(prices: Readonly<Record<string, Paise>>): void {
    for (const [symbol, price] of Object.entries(prices)) this.mark(symbol, price);
  }

  getPosition(symbol: string): Position | undefined {
    const position = this.positions.get(symbol);
    if (!position) return undefined;
    return toPosition(position);
  }

  /** Open positions only — flat symbols are excluded. */
  getOpenPositions(): Position[] {
    return [...this.positions.values()]
      .filter((position) => position.quantity !== 0)
      .map(toPosition);
  }

  get cash(): Paise {
    return this.cashBalance;
  }

  get closedTrades(): readonly ClosedTrade[] {
    return this.trades;
  }

  /**
   * Cash plus the marked value of open positions.
   *
   * A short position contributes negative market value, which is correct: the
   * sale proceeds are already sitting in cash and buying the position back
   * will cost the current price.
   */
  get equity(): Paise {
    let marketValue = 0;
    for (const position of this.positions.values()) {
      marketValue += position.quantity * position.lastPrice;
    }
    return fromPaise(this.cashBalance + marketValue);
  }

  get unrealisedPnl(): Paise {
    let total = 0;
    for (const position of this.positions.values()) {
      if (position.quantity === 0) continue;
      total += position.quantity * (position.lastPrice - position.averagePrice);
    }
    return fromPaise(total);
  }

  get realisedPnl(): Paise {
    let total = 0;
    for (const position of this.positions.values()) total += position.realisedPnl;
    return fromPaise(total);
  }

  snapshot(): PortfolioSnapshot {
    return {
      cash: this.cashBalance,
      equity: this.equity,
      positions: this.getOpenPositions(),
      realisedPnl: this.realisedPnl,
      unrealisedPnl: this.unrealisedPnl,
      totalCommission: this.commissionPaid,
    };
  }
}

function toPosition(position: MutablePosition): Position {
  const unrealised =
    position.quantity === 0
      ? (0 as Paise)
      : fromPaise(position.quantity * (position.lastPrice - position.averagePrice));

  return {
    symbol: position.symbol,
    quantity: position.quantity,
    averagePrice: position.averagePrice,
    realisedPnl: position.realisedPnl,
    unrealisedPnl: unrealised,
    lastPrice: position.lastPrice,
  };
}
