/**
 * Loads historical candles into the database.
 *
 * This is the step the README calls "the next step is data, not code": the
 * backtester, the walk-forward machinery and the live loop all read from the
 * `candle` table, and none of them can do anything until it has real bars in
 * it.
 *
 * Two sources, because the two jobs are different. Kite's historical endpoint
 * is convenient but capped — a retail session will not hand back five years of
 * minute bars — so long-range history usually arrives as files. Both go through
 * the same validation and the same upsert.
 *
 *   # From the broker (needs a live Kite session)
 *   npm run backfill -- --source kite --symbols NSE:RELIANCE,NSE:TCS \
 *     --interval 1d --from 2019-01-01
 *
 *   # From CSV files
 *   npm run backfill -- --source csv --interval 1d \
 *     --file NSE:RELIANCE=./data/reliance.csv \
 *     --file NSE:TCS=./data/tcs.csv
 *
 * Re-running is safe: bars are upserted by (symbol, interval, timestamp), so a
 * corrected file overwrites what it should and changes nothing else.
 */

import { Database, databaseOptionsFromEnv } from '../src/persistence/postgres';
import { MarketDataIngestor } from '../src/marketdata/ingestion';
import { KiteHistoricalProvider } from '../src/marketdata/kiteHistorical';
import { CsvMarketDataProvider } from '../src/marketdata/csvProvider';
import type { MarketDataProvider } from '../src/marketdata/provider';
import type { Interval } from '../src/domain/types';

const INTERVALS: readonly Interval[] = ['1m', '5m', '15m', '1h', '1d'];

interface Options {
  source: 'kite' | 'csv';
  symbols: string[];
  files: Map<string, string>;
  interval: Interval;
  from: number;
  to: number;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(`Usage: npm run backfill -- --source <kite|csv> [options]

  --source <kite|csv>     Where to read history from (required)
  --symbols  a,b,c        Symbols to load (required for --source kite)
  --file SYM=path         CSV file for a symbol; repeatable (--source csv)
  --interval <${INTERVALS.join('|')}>   Bar size (default: 1d)
  --from YYYY-MM-DD       Start of the range (default: 5 years ago)
  --to   YYYY-MM-DD       End of the range (default: now)

Environment: DATABASE_URL, and for --source kite: KITE_API_KEY, KITE_ACCESS_TOKEN.`);
  process.exit(1);
}

function parseDate(value: string, label: string): number {
  // Interpreted as the IST session open, matching how a bare date is read
  // everywhere else in the platform.
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T09:15:00+05:30`)
    : Date.parse(value);
  if (Number.isNaN(parsed)) usage(`${label} is not a date: ${value}`);
  return parsed;
}

function parseArgs(argv: readonly string[]): Options {
  const files = new Map<string, string>();
  let source: string | undefined;
  let symbols: string[] = [];
  let interval: Interval = '1d';
  let from = Date.now() - 5 * 365 * 24 * 60 * 60 * 1000;
  let to = Date.now();

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    switch (flag) {
      case '--source':
        if (!value) usage('--source needs a value');
        source = value;
        i += 1;
        break;
      case '--symbols':
        if (!value) usage('--symbols needs a value');
        symbols = value.split(',').map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      case '--file': {
        if (!value) usage('--file needs SYMBOL=path');
        const at = value.indexOf('=');
        if (at < 0) usage(`--file expects SYMBOL=path, got ${value}`);
        files.set(value.slice(0, at).trim(), value.slice(at + 1).trim());
        i += 1;
        break;
      }
      case '--interval':
        if (!value || !INTERVALS.includes(value as Interval)) {
          usage(`--interval must be one of ${INTERVALS.join(', ')}`);
        }
        interval = value as Interval;
        i += 1;
        break;
      case '--from':
        if (!value) usage('--from needs a date');
        from = parseDate(value, '--from');
        i += 1;
        break;
      case '--to':
        if (!value) usage('--to needs a date');
        to = parseDate(value, '--to');
        i += 1;
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        if (flag?.startsWith('--')) usage(`unknown flag ${flag}`);
    }
  }

  if (source !== 'kite' && source !== 'csv') usage('--source must be kite or csv');
  if (source === 'csv' && files.size === 0) usage('--source csv needs at least one --file');
  if (source === 'kite' && symbols.length === 0) usage('--source kite needs --symbols');
  if (from > to) usage('--from is after --to');

  // For CSV, the files themselves name the symbols.
  if (source === 'csv' && symbols.length === 0) symbols = [...files.keys()];

  return { source, symbols, files, interval, from, to };
}

function buildProvider(options: Options): MarketDataProvider {
  if (options.source === 'csv') return new CsvMarketDataProvider(options.files);

  const apiKey = process.env.KITE_API_KEY;
  const accessToken = process.env.KITE_ACCESS_TOKEN;
  if (!apiKey || !accessToken) {
    usage('--source kite requires KITE_API_KEY and KITE_ACCESS_TOKEN');
  }
  return new KiteHistoricalProvider({ apiKey, accessToken });
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const database = new Database(
    process.env.DATABASE_URL ?? 'postgres://trader:trader@127.0.0.1:5432/trading',
    databaseOptionsFromEnv(),
  );

  try {
    await database.migrate();
    const repositories = database.repositories();

    const ingestor = new MarketDataIngestor({
      provider: buildProvider(options),
      candles: repositories.candles,
      state: repositories.state,
    });

    console.log(
      `Backfilling ${options.symbols.length} symbol(s) at ${options.interval} ` +
        `from ${new Date(options.from).toISOString().slice(0, 10)} ` +
        `to ${new Date(options.to).toISOString().slice(0, 10)}\n`,
    );

    let totalStored = 0;
    let failures = 0;

    for (const symbol of options.symbols) {
      process.stdout.write(`  ${symbol.padEnd(20)} `);
      try {
        const summary = await ingestor.backfill(symbol, options.interval, options.from, options.to);
        totalStored += summary.stored;

        const latest = summary.latest
          ? new Date(summary.latest).toISOString().slice(0, 10)
          : 'none';
        console.log(
          `${String(summary.stored).padStart(7)} stored` +
            `${summary.rejected > 0 ? `, ${summary.rejected} rejected` : ''}` +
            `  (latest ${latest})`,
        );
      } catch (error) {
        failures += 1;
        console.log(`FAILED — ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log(`\n${totalStored} bar(s) stored, ${failures} symbol(s) failed.`);

    if (totalStored > 0) {
      console.log(
        'Next: run a backtest over the loaded range before trusting any of it —\n' +
          '  npm run backtest',
      );
    }

    // A partial backfill is a real failure for automation: exiting 0 would let
    // a pipeline proceed to a backtest over history it does not actually have.
    process.exitCode = failures > 0 ? 1 : 0;
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error('backfill failed:', error);
    process.exit(1);
  });
}
