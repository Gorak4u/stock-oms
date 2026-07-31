import { fromRupees, type Paise } from '../src/domain/money';
import type { Fill } from '../src/domain/types';
import { Portfolio } from '../src/execution/portfolio';

function fill(overrides: Partial<Fill> = {}): Fill {
  return {
    orderId: 'ord-1',
    symbol: 'NSE:RELIANCE',
    side: 'BUY',
    quantity: 100,
    price: fromRupees(2500),
    timestamp: 1_700_000_000_000,
    commission: 0 as Paise,
    ...overrides,
  };
}

describe('Portfolio — long lifecycle', () => {
  it('opens a long and moves cash out', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    portfolio.applyFill(fill());

    expect(portfolio.cash).toBe(fromRupees(750_000));
    expect(portfolio.getPosition('NSE:RELIANCE')!.quantity).toBe(100);
    expect(portfolio.getPosition('NSE:RELIANCE')!.averagePrice).toBe(fromRupees(2500));
    // Equity is unchanged: cash became stock at the same value.
    expect(portfolio.equity).toBe(fromRupees(1_000_000));
  });

  it('averages up when adding to a long', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    portfolio.applyFill(fill({ quantity: 100, price: fromRupees(2500) }));
    portfolio.applyFill(fill({ quantity: 100, price: fromRupees(2700) }));

    const position = portfolio.getPosition('NSE:RELIANCE')!;
    expect(position.quantity).toBe(200);
    expect(position.averagePrice).toBe(fromRupees(2600));
  });

  it('realises profit when closing a long', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    portfolio.applyFill(fill({ quantity: 100, price: fromRupees(2500) }));
    const closed = portfolio.applyFill(
      fill({ side: 'SELL', quantity: 100, price: fromRupees(2600) }),
    );

    expect(closed).not.toBeNull();
    expect(closed!.direction).toBe('LONG');
    expect(closed!.pnl).toBe(fromRupees(10_000)); // 100 × ₹100
    expect(portfolio.getPosition('NSE:RELIANCE')!.quantity).toBe(0);
    expect(portfolio.equity).toBe(fromRupees(1_010_000));
  });

  it('realises a loss when a long is closed below entry', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    portfolio.applyFill(fill({ quantity: 100, price: fromRupees(2500) }));
    const closed = portfolio.applyFill(
      fill({ side: 'SELL', quantity: 100, price: fromRupees(2400) }),
    );

    expect(closed!.pnl).toBe(fromRupees(-10_000));
    expect(portfolio.equity).toBe(fromRupees(990_000));
  });

  it('realises only the closed portion on a partial exit', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    portfolio.applyFill(fill({ quantity: 100, price: fromRupees(2500) }));
    const closed = portfolio.applyFill(
      fill({ side: 'SELL', quantity: 40, price: fromRupees(2600) }),
    );

    expect(closed!.quantity).toBe(40);
    expect(closed!.pnl).toBe(fromRupees(4_000));

    const position = portfolio.getPosition('NSE:RELIANCE')!;
    expect(position.quantity).toBe(60);
    // The average price of what is still held does not change on an exit.
    expect(position.averagePrice).toBe(fromRupees(2500));
  });
});

describe('Portfolio — short lifecycle', () => {
  it('opens a short and brings cash in', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    portfolio.applyFill(fill({ side: 'SELL', quantity: 100, price: fromRupees(2500) }));

    expect(portfolio.cash).toBe(fromRupees(1_250_000));
    expect(portfolio.getPosition('NSE:RELIANCE')!.quantity).toBe(-100);
    // The short's negative market value offsets the sale proceeds.
    expect(portfolio.equity).toBe(fromRupees(1_000_000));
  });

  it('profits when a short is covered lower', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    portfolio.applyFill(fill({ side: 'SELL', quantity: 100, price: fromRupees(2500) }));
    const closed = portfolio.applyFill(
      fill({ side: 'BUY', quantity: 100, price: fromRupees(2400) }),
    );

    expect(closed!.direction).toBe('SHORT');
    expect(closed!.pnl).toBe(fromRupees(10_000));
    expect(portfolio.equity).toBe(fromRupees(1_010_000));
  });

  it('loses when a short is covered higher', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    portfolio.applyFill(fill({ side: 'SELL', quantity: 100, price: fromRupees(2500) }));
    const closed = portfolio.applyFill(
      fill({ side: 'BUY', quantity: 100, price: fromRupees(2600) }),
    );

    expect(closed!.pnl).toBe(fromRupees(-10_000));
  });

  it('marks an unrealised short loss as price rises', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    portfolio.applyFill(fill({ side: 'SELL', quantity: 100, price: fromRupees(2500) }));
    portfolio.mark('NSE:RELIANCE', fromRupees(2600));

    expect(portfolio.unrealisedPnl).toBe(fromRupees(-10_000));
    expect(portfolio.equity).toBe(fromRupees(990_000));
  });
});

describe('Portfolio — reversal through zero', () => {
  it('realises the close and opens the surplus at the fill price', () => {
    const portfolio = new Portfolio(fromRupees(10_000_000));
    portfolio.applyFill(fill({ quantity: 100, price: fromRupees(2500) }));

    // Sell 250: closes the 100 long, opens 150 short.
    const closed = portfolio.applyFill(
      fill({ side: 'SELL', quantity: 250, price: fromRupees(2600) }),
    );

    expect(closed!.quantity).toBe(100);
    expect(closed!.pnl).toBe(fromRupees(10_000));

    const position = portfolio.getPosition('NSE:RELIANCE')!;
    expect(position.quantity).toBe(-150);
    expect(position.averagePrice).toBe(fromRupees(2600));
  });
});

describe('Portfolio — commission', () => {
  it('takes commission out of cash and out of realised P&L', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    portfolio.applyFill(fill({ quantity: 100, price: fromRupees(2500), commission: fromRupees(20) }));
    const closed = portfolio.applyFill(
      fill({
        side: 'SELL',
        quantity: 100,
        price: fromRupees(2600),
        commission: fromRupees(30),
      }),
    );

    // ₹10,000 gross less the ₹30 closing commission.
    expect(closed!.pnl).toBe(fromRupees(9_970));
    // Equity carries both legs' commission.
    expect(portfolio.equity).toBe(fromRupees(1_009_950));
    expect(portfolio.snapshot().totalCommission).toBe(fromRupees(50));
  });
});

describe('Portfolio — bookkeeping', () => {
  it('excludes flat symbols from open positions', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    portfolio.applyFill(fill({ quantity: 100 }));
    portfolio.applyFill(fill({ side: 'SELL', quantity: 100 }));

    expect(portfolio.getOpenPositions()).toHaveLength(0);
  });

  it('tracks several symbols independently', () => {
    const portfolio = new Portfolio(fromRupees(10_000_000));
    portfolio.applyFill(fill({ symbol: 'A', quantity: 100, price: fromRupees(1000) }));
    portfolio.applyFill(fill({ symbol: 'B', quantity: 50, price: fromRupees(2000) }));
    portfolio.markAll({ A: fromRupees(1100), B: fromRupees(1900) });

    expect(portfolio.getPosition('A')!.unrealisedPnl).toBe(fromRupees(10_000));
    expect(portfolio.getPosition('B')!.unrealisedPnl).toBe(fromRupees(-5_000));
    expect(portfolio.unrealisedPnl).toBe(fromRupees(5_000));
  });

  it('rebuilds an identical equity curve from the same fill sequence', () => {
    const fills = [
      fill({ quantity: 100, price: fromRupees(2500) }),
      fill({ side: 'SELL', quantity: 50, price: fromRupees(2600) }),
      fill({ quantity: 25, price: fromRupees(2450) }),
      fill({ side: 'SELL', quantity: 75, price: fromRupees(2550) }),
    ];

    const first = new Portfolio(fromRupees(1_000_000));
    const second = new Portfolio(fromRupees(1_000_000));
    for (const f of fills) first.applyFill(f);
    for (const f of fills) second.applyFill(f);

    expect(first.snapshot()).toEqual(second.snapshot());
  });

  it('rejects a non-positive fill quantity', () => {
    const portfolio = new Portfolio(fromRupees(1_000_000));
    expect(() => portfolio.applyFill(fill({ quantity: 0 }))).toThrow();
  });
});
