import {
  add,
  divFloor,
  format,
  fromPaise,
  fromRupees,
  isOnTick,
  MoneyError,
  mulQty,
  mulRate,
  roundToTick,
  sub,
  toRupees,
} from '../src/domain/money';

describe('money', () => {
  describe('fromRupees', () => {
    it('converts without float drift on prices that break naive multiplication', () => {
      // 19.99 * 100 is 1998.9999999999998 in IEEE-754.
      expect(fromRupees(19.99)).toBe(1999);
      expect(fromRupees(0.1)).toBe(10);
      expect(fromRupees(2456.35)).toBe(245635);
    });

    it('rounds half away from zero, symmetrically for negatives', () => {
      expect(fromRupees(0.005)).toBe(1);
      expect(fromRupees(-0.005)).toBe(-1);
    });

    it('rejects non-finite input', () => {
      expect(() => fromRupees(Number.NaN)).toThrow(MoneyError);
      expect(() => fromRupees(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    });
  });

  it('round-trips through rupees', () => {
    expect(toRupees(fromRupees(1234.56))).toBeCloseTo(1234.56, 10);
  });

  it('accumulates exactly where repeated float addition would drift', () => {
    let total = fromPaise(0);
    for (let i = 0; i < 1000; i += 1) total = add(total, fromRupees(0.1));
    expect(total).toBe(10000); // exactly ₹100.00
    expect(toRupees(total)).toBe(100);
  });

  it('subtracts and multiplies by whole quantities exactly', () => {
    expect(sub(fromRupees(100), fromRupees(30.5))).toBe(6950);
    expect(mulQty(fromRupees(245.75), 400)).toBe(9830000);
  });

  it('rejects fractional quantities', () => {
    expect(() => mulQty(fromRupees(100), 1.5)).toThrow(MoneyError);
  });

  describe('mulRate', () => {
    it('rounds half away from zero so charges never favour the trader', () => {
      expect(mulRate(fromPaise(101), 0.005)).toBe(1); // 0.505 → 1
      expect(mulRate(fromPaise(-101), 0.005)).toBe(-1);
    });
  });

  describe('divFloor', () => {
    it('never returns a quantity the budget cannot pay for', () => {
      expect(divFloor(fromRupees(10000), fromRupees(245.75))).toBe(40);
      expect(divFloor(fromRupees(245.74), fromRupees(245.75))).toBe(0);
    });

    it('returns zero for a non-positive budget', () => {
      expect(divFloor(fromPaise(-500), fromRupees(10))).toBe(0);
    });

    it('rejects a non-positive unit price', () => {
      expect(() => divFloor(fromRupees(100), fromPaise(0))).toThrow(MoneyError);
    });
  });

  describe('roundToTick', () => {
    it('snaps to the 5-paise NSE grid', () => {
      expect(roundToTick(fromPaise(10003))).toBe(10005);
      expect(roundToTick(fromPaise(10001))).toBe(10000);
    });

    it('rounds a buy down and a sell up, never more aggressive than intended', () => {
      expect(roundToTick(fromPaise(10003), 'down')).toBe(10000);
      expect(roundToTick(fromPaise(10001), 'up')).toBe(10005);
    });

    it('recognises on-tick prices', () => {
      expect(isOnTick(fromPaise(10005))).toBe(true);
      expect(isOnTick(fromPaise(10003))).toBe(false);
    });
  });

  describe('format', () => {
    it('uses Indian digit grouping', () => {
      expect(format(fromRupees(123456.78))).toBe('₹1,23,456.78');
      expect(format(fromRupees(999))).toBe('₹999.00');
      expect(format(fromRupees(1000))).toBe('₹1,000.00');
      expect(format(fromRupees(10000000))).toBe('₹1,00,00,000.00');
    });

    it('renders negatives with the sign outside the symbol', () => {
      expect(format(fromRupees(-4500.5))).toBe('-₹4,500.50');
    });
  });
});
