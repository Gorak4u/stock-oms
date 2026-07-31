/**
 * Money arithmetic for the platform.
 *
 * Every monetary value is stored as an integer number of paise (1/100 of a
 * rupee). Floating-point rupees are never used for arithmetic that feeds an
 * order, a P&L figure, or a risk check: `0.1 + 0.2 !== 0.3` is a rounding bug
 * in a spreadsheet, but in an execution path it is a reconciliation break that
 * has to be chased through an audit log.
 *
 * Rupee floats are accepted only at the boundary (`fromRupees`) and produced
 * only for display (`toRupees`, `format`).
 */

declare const paiseBrand: unique symbol;

/** An integer number of paise. Construct via {@link fromRupees}/{@link fromPaise}. */
export type Paise = number & { readonly [paiseBrand]: 'Paise' };

/** NSE equity tick size is 5 paise (₹0.05); prices off the tick are rejected by the exchange. */
export const TICK_SIZE_PAISE = 5;

export const ZERO = 0 as Paise;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Wraps an already-integral paise count. Throws if it is not a safe integer. */
export function fromPaise(paise: number): Paise {
  if (!Number.isSafeInteger(paise)) {
    throw new MoneyError(`paise must be a safe integer, got ${paise}`);
  }
  return paise as Paise;
}

/**
 * Converts a rupee amount to paise, rounding half-away-from-zero.
 *
 * The `* 100` is done on a value already rounded to 10 decimal places because
 * `19.99 * 100` is `1998.9999999999998` in IEEE-754 — truncating that would
 * silently lose a paise on a large fraction of real prices.
 */
export function fromRupees(rupees: number): Paise {
  if (!Number.isFinite(rupees)) {
    throw new MoneyError(`rupees must be finite, got ${rupees}`);
  }
  const scaled = Number((rupees * 100).toFixed(10));
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return fromPaise(rounded);
}

export function toRupees(paise: Paise): number {
  return paise / 100;
}

export function add(a: Paise, b: Paise): Paise {
  return fromPaise(a + b);
}

export function sub(a: Paise, b: Paise): Paise {
  return fromPaise(a - b);
}

export function neg(a: Paise): Paise {
  return fromPaise(-a);
}

export function abs(a: Paise): Paise {
  return fromPaise(Math.abs(a));
}

/** Multiplies a price by a whole quantity (shares/lots). Exact — no rounding. */
export function mulQty(price: Paise, quantity: number): Paise {
  if (!Number.isSafeInteger(quantity)) {
    throw new MoneyError(`quantity must be a safe integer, got ${quantity}`);
  }
  return fromPaise(price * quantity);
}

/**
 * Scales money by a real-valued rate (a percentage, a slippage factor, a
 * brokerage rate). Rounds half-away-from-zero so that charges never round to
 * the trader's advantage by construction.
 */
export function mulRate(amount: Paise, rate: number): Paise {
  if (!Number.isFinite(rate)) {
    throw new MoneyError(`rate must be finite, got ${rate}`);
  }
  const scaled = amount * rate;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return fromPaise(rounded);
}

/**
 * How many whole units of `unitPrice` fit inside `budget`.
 *
 * Always rounds down: a position sizer must never return a quantity the
 * account cannot actually pay for.
 */
export function divFloor(budget: Paise, unitPrice: Paise): number {
  if (unitPrice <= 0) {
    throw new MoneyError(`unitPrice must be positive, got ${unitPrice}`);
  }
  if (budget <= 0) return 0;
  return Math.floor(budget / unitPrice);
}

/** `a / b` as a plain ratio (e.g. for drawdown percentages). Returns 0 when `b` is 0. */
export function ratio(a: Paise, b: Paise): number {
  if (b === 0) return 0;
  return a / b;
}

export function sum(amounts: readonly Paise[]): Paise {
  let total = 0;
  for (const amount of amounts) total += amount;
  return fromPaise(total);
}

export function max(a: Paise, b: Paise): Paise {
  return a >= b ? a : b;
}

export function min(a: Paise, b: Paise): Paise {
  return a <= b ? a : b;
}

/**
 * Snaps a price to the exchange tick grid.
 *
 * Buy orders round down and sell orders round up, so that rounding can only
 * ever make a resting order less aggressive than intended — never more.
 */
export function roundToTick(price: Paise, direction: 'down' | 'up' | 'nearest' = 'nearest'): Paise {
  const ticks = price / TICK_SIZE_PAISE;
  const snapped =
    direction === 'down' ? Math.floor(ticks)
    : direction === 'up' ? Math.ceil(ticks)
    : Math.round(ticks);
  return fromPaise(snapped * TICK_SIZE_PAISE);
}

export function isOnTick(price: Paise): boolean {
  return price % TICK_SIZE_PAISE === 0;
}

/** Formats as `₹1,23,456.78` (Indian digit grouping). */
export function format(paise: Paise): string {
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const rupees = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');

  const digits = String(rupees);
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  }

  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}
