/**
 * Seeds a database with synthetic data so the platform can be exercised end to
 * end without a broker account or real market history.
 *
 * A fresh install has an empty `candle` table, which means an empty dashboard
 * and a trading loop with nothing to decide on. That is correct behaviour and
 * completely uninformative: you cannot tell a working system from a broken one
 * when both show zero. This fills in enough for every screen to have something
 * real on it.
 *
 * It does not insert rows into `order` and `trade` directly. It drives the
 * actual pipeline — signal → risk → sizing → OMS → paper broker → fill →
 * portfolio → persistence → audit — one bar at a time, so what you end up
 * looking at was produced by the same code that would run against a live
 * broker. Seeding this way tests the wiring; seeding by INSERT would only test
 * the dashboard's ability to render rows.
 *
 *   npm run seed -- --reset
 *   npm run seed -- --symbols NSE:RELIANCE,NSE:TCS --days 500 --seed 11
 *
 * The data is synthetic and says nothing whatever about whether these
 * strategies make money. It exists to prove the plumbing carries water.
 */

import { Database, databaseOptionsFromEnv } from '../src/persistence/postgres';
import { MarketDataIngestor } from '../src/marketdata/ingestion';
import type { CandleQuery, MarketDataProvider } from '../src/marketdata/provider';
import { TradingService, type StrategyKind } from '../src/runtime/tradingService';
import { PaperBroker } from '../src/execution/paperBroker';
import { MarketCalendar, NSE_HOLIDAYS_2026, fromIst, toIstDate } from '../src/marketdata/calendar';
import { syntheticSeries } from '../src/browser';
import { fromRupees, toRupees, roundToTick, type Paise } from '../src/domain/money';
import type { Candle, Interval, Timestamp } from '../src/domain/types';

const SESSION_OPEN = 9 * 60 + 15;
const SESSION_CLOSE = 15 * 60 + 30;
/** Daily bars are stamped near the close, inside the session, so risk sees an open market. */
const DAILY_STAMP = 15 * 60 + 15;

interface Options {
  symbols: string[];
  days: number;
  seed: number;
  reset: boolean;
  strategy: StrategyKind;
  capital: number;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(`Usage: npm run seed -- [options]

  --symbols a,b,c   Symbols to generate (default: NSE:RELIANCE,NSE:TCS,NSE:INFY)
  --days N          Trading days of daily history (default: 400)
  --seed N          PRNG seed; the same seed reproduces the same data (default: 7)
  --strategy S      trend | meanReversion | momentum | volatility (default: trend)
  --capital N       Opening capital in rupees (default: 1000000)
  --reset           Clear existing data first (required if the tables are not empty)

Environment: DATABASE_URL`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    symbols: ['NSE:RELIANCE', 'NSE:TCS', 'NSE:INFY'],
    days: 400,
    seed: 7,
    reset: false,
    strategy: 'trend',
    capital: 1_000_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    const number = (name: string): number => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) usage(`${name} needs a positive number`);
      i += 1;
      return n;
    };

    switch (flag) {
      case '--symbols':
        if (!value) usage('--symbols needs a value');
        options.symbols = value.split(',').map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      case '--days': options.days = Math.trunc(number('--days')); break;
      case '--seed': options.seed = Math.trunc(number('--seed')); break;
      case '--capital': options.capital = number('--capital'); break;
      case '--strategy':
        if (!value) usage('--strategy needs a value');
        options.strategy = value as StrategyKind;
        i += 1;
        break;
      case '--reset': options.reset = true; break;
      case '--help': case '-h': usage(); break;
      default:
        if (flag?.startsWith('--')) usage(`unknown flag ${flag}`);
    }
  }

  if (options.symbols.length === 0) usage('at least one symbol is required');
  if (options.days < 120) usage('--days must be at least 120; strategies need a warm-up');

  return options;
}

/**
 * The last `count` NSE trading days, oldest first, ending yesterday.
 *
 * Ends yesterday rather than today so nothing is stamped in the future — the
 * ingestor rejects future bars, correctly, as lookahead.
 */
function tradingDays(calendar: MarketCalendar, count: number, now: Timestamp): string[] {
  const days: string[] = [];
  const cursor = new Date(now);
  cursor.setUTCDate(cursor.getUTCDate() - 1);

  // Bounded so a calendar with an implausible holiday list cannot spin forever.
  for (let guard = 0; days.length < count && guard < count * 3 + 400; guard += 1) {
    const date = toIstDate(cursor.getTime());
    if (calendar.isMarketOpen(fromIst(date, DAILY_STAMP))) days.push(date);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return days.reverse();
}

/** Re-stamps a generated price path onto real session times for one symbol. */
function dailyBars(
  symbol: string,
  days: readonly string[],
  seed: number,
  startPrice: number,
): Candle[] {
  const path = syntheticSeries(days.length, seed, {
    startPrice,
    volatility: 0.022,
    // Enough regime structure that a trend strategy has something to find.
    // On a pure random walk it correctly finds almost nothing, which makes for
    // an accurate but completely blank demonstration.
    regimeStrength: 0.0016,
  });

  return days.map((day, i) => {
    const bar = path[i]!;
    // Prices must sit on the exchange tick grid, or the OMS is being handed
    // something a real venue would reject.
    const open = roundToTick(bar.open);
    const close = roundToTick(bar.close);
    const high = roundToTick(bar.high);
    const low = roundToTick(bar.low);

    return {
      symbol,
      interval: '1d' as Interval,
      timestamp: fromIst(day, DAILY_STAMP),
      open,
      close,
      // Re-assert the invariant after rounding: high must bracket the body.
      high: Math.max(high, open, close) as Paise,
      low: Math.min(low, open, close) as Paise,
      volume: bar.volume,
    };
  });
}

/**
 * Minute bars for the most recent session.
 *
 * The live runner reads `1m`, so without these a seeded system still reports
 * stale market data and the loop still has nothing to read — the seed would
 * look complete while leaving the actual trading path empty.
 */
function minuteBars(symbol: string, day: string, closePrice: Paise, seed: number): Candle[] {
  const minutes = SESSION_CLOSE - SESSION_OPEN;
  const path = syntheticSeries(minutes, seed + 991, {
    startPrice: toRupees(closePrice),
    volatility: 0.0016,
    regimeStrength: 0.00004,
  });

  return path.map((bar, i) => {
    const open = roundToTick(bar.open);
    const close = roundToTick(bar.close);
    return {
      symbol,
      interval: '1m' as Interval,
      timestamp: fromIst(day, SESSION_OPEN + i),
      open,
      close,
      high: Math.max(roundToTick(bar.high), open, close) as Paise,
      low: Math.min(roundToTick(bar.low), open, close) as Paise,
      volume: Math.round(bar.volume / 200),
    };
  });
}

/** Serves already-generated bars, so seeding goes through the real ingestion path. */
class InMemoryProvider implements MarketDataProvider {
  readonly name = 'seed';

  constructor(private readonly bars: ReadonlyMap<string, Candle[]>) {}

  async fetchCandles(query: CandleQuery): Promise<Candle[]> {
    const key = `${query.symbol}|${query.interval}`;
    return (this.bars.get(key) ?? []).filter(
      (c) => c.timestamp >= query.from && c.timestamp <= query.to,
    );
  }
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const now = Date.now();

  const database = new Database(
    process.env.DATABASE_URL ?? 'postgres://trader:trader@127.0.0.1:5432/trading',
    databaseOptionsFromEnv(),
  );

  try {
    await database.migrate();
    const repositories = database.repositories();

    // ---- guard against clobbering real data ------------------------------

    const { rows } = await database.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM trading.candle',
    );
    const existing = Number(rows[0]?.count ?? 0);

    if (existing > 0 && !options.reset) {
      console.error(
        `This database already holds ${existing} candle(s).\n` +
          'Refusing to mix synthetic data into it — that would quietly corrupt any real\n' +
          'history you have loaded, and there is no way to tell the two apart afterwards.\n\n' +
          'Re-run with --reset to clear it first, or point DATABASE_URL somewhere else.',
      );
      process.exit(1);
    }

    if (options.reset) {
      await database.pool.query(`
        TRUNCATE trading.fill, trading."order", trading.closed_trade, trading.position,
                 trading.equity_point, trading.audit_record, trading.candle,
                 trading.model, trading.runtime_state, trading.reconciliation_break
        RESTART IDENTITY CASCADE`);
      console.log('Cleared existing data.\n');
    }

    // ---- generate ---------------------------------------------------------

    const calendar = new MarketCalendar({ holidays: NSE_HOLIDAYS_2026 });
    const days = tradingDays(calendar, options.days, now);

    if (days.length < 120) {
      throw new Error(`only ${days.length} trading days available; need at least 120`);
    }

    const lastDay = days[days.length - 1]!;
    const bars = new Map<string, Candle[]>();

    options.symbols.forEach((symbol, i) => {
      // A different seed and start price per symbol, so they are not all the
      // same series under different names.
      const seed = options.seed + i * 137;
      const daily = dailyBars(symbol, days, seed, 800 + i * 550);
      bars.set(`${symbol}|1d`, daily);
      bars.set(
        `${symbol}|1m`,
        minuteBars(symbol, lastDay, daily[daily.length - 1]!.close, seed),
      );
    });

    console.log(
      `Seeding ${options.symbols.length} symbol(s) over ${days.length} trading days ` +
        `(${days[0]} → ${lastDay}), seed ${options.seed}.\n`,
    );

    // ---- ingest through the real path -------------------------------------

    const ingestor = new MarketDataIngestor({
      provider: new InMemoryProvider(bars),
      candles: repositories.candles,
      state: repositories.state,
    });

    let stored = 0;
    for (const symbol of options.symbols) {
      for (const interval of ['1d', '1m'] as const) {
        const series = bars.get(`${symbol}|${interval}`)!;
        const summary = await ingestor.backfill(
          symbol, interval, series[0]!.timestamp, series[series.length - 1]!.timestamp,
        );
        stored += summary.stored;
        if (summary.rejected > 0) {
          throw new Error(
            `generated ${summary.rejected} invalid ${interval} bar(s) for ${symbol} — ` +
              'this is a bug in the seed generator, not in your data',
          );
        }
      }
    }
    console.log(`  market data      ${stored} bars stored`);

    // ---- drive the real pipeline ------------------------------------------

    const broker = new PaperBroker({ openingCash: fromRupees(options.capital) });
    const service = new TradingService({
      repositories,
      broker,
      openingCash: fromRupees(options.capital),
      calendar,
      strategyKind: options.strategy,
      symbols: options.symbols,
    });

    await service.start();
    // AUTOMATIC so orders actually flow. Reset to MANUAL at the end — leaving a
    // seeded system able to trade unattended is not a state to hand anyone.
    await service.setMode('AUTOMATIC', 'seed');

    const daily = options.symbols.map((s) => bars.get(`${s}|1d`)!);
    let fillCount = 0;

    for (let i = 0; i < days.length; i += 1) {
      for (let s = 0; s < options.symbols.length; s += 1) {
        const symbol = options.symbols[s]!;
        const series = daily[s]!;
        const bar = series[i]!;

        broker.setClock(bar.timestamp);

        // Orders placed on the previous bar's close fill against this bar —
        // the same next-bar fill rule the backtester uses. Filling on the
        // decision bar would be lookahead.
        for (const fill of broker.setPrice(symbol, bar.open, bar.volume)) {
          await service.applyFill(fill);
          fillCount += 1;
        }

        await service.onBar(symbol, series.slice(0, i + 1));
      }
    }

    // One final pass so the last bar's orders are not left resting forever.
    for (let s = 0; s < options.symbols.length; s += 1) {
      const series = daily[s]!;
      const last = series[series.length - 1]!;
      broker.setClock(last.timestamp + 60_000);
      for (const fill of broker.setPrice(options.symbols[s]!, last.close, last.volume)) {
        await service.applyFill(fill);
        fillCount += 1;
      }
    }

    await service.setMode('MANUAL', 'seed');

    // ---- report ------------------------------------------------------------

    const [orders, trades, positions, equity, audit, breaks] = await Promise.all([
      repositories.orders.findRecent(100_000),
      repositories.trades.recent(100_000),
      repositories.positions.open(),
      repositories.equity.between(0, Date.now()),
      repositories.audit.recent(100_000),
      repositories.reconciliation.open(),
    ]);

    const status = service.status();
    const pnl = toRupees(status.equity) - options.capital;

    console.log(`  orders           ${orders.length}`);
    console.log(`  fills            ${fillCount}`);
    console.log(`  closed trades    ${trades.length}`);
    console.log(`  open positions   ${positions.length}`);
    console.log(`  equity points    ${equity.length}`);
    console.log(`  audit records    ${audit.length}  (chain ${service.audit.verifyChain() === null ? 'intact' : 'BROKEN'})`);
    console.log(`  recon breaks     ${breaks.length}`);
    console.log(
      `\n  closing equity   ₹${toRupees(status.equity).toLocaleString('en-IN')} ` +
        `(${pnl >= 0 ? '+' : ''}₹${pnl.toLocaleString('en-IN')})`,
    );
    console.log(`  automation mode  ${status.mode}  ← reset, so nothing trades unattended`);

    if (orders.length === 0) {
      // Not an error, but the seed has failed at its one job.
      console.log(
        '\nNo orders were generated. The dashboard will still be empty.\n' +
          'Try a different --seed, or --strategy meanReversion.',
      );
    }

    console.log(`
Synthetic data. It demonstrates that the pipeline carries a decision from bar to
fill to ledger; it says nothing about whether this strategy makes money. Do not
read the equity curve as a result.

Next:
  npm start                     then open http://localhost:8080
                                paste your API_TOKEN into the field at top right
  http://localhost:8080/console backtest the same symbols in the browser
`);
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exit(1);
  });
}
