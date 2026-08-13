import { EventEmitter } from 'node:events';
import { fromRupees, toRupees } from '../src/domain/money';
import type { Candle, Interval, Timestamp } from '../src/domain/types';
import {
  isIndexToken,
  KiteTicker,
  parseTickerFrame,
  type KiteTickerConfig,
  type TickerSocket,
} from '../src/marketdata/kiteTicker';
import { LiveFeed } from '../src/marketdata/liveFeed';
import { MarketCalendar, fromIst, NSE_HOLIDAYS_2026 } from '../src/marketdata/calendar';
import type { CandleRepository } from '../src/persistence/ports';

// ---------------------------------------------------------------------------
// Frame construction — mirrors what Kite puts on the wire, so the parser is
// tested against the layout rather than against its own assumptions.
// ---------------------------------------------------------------------------

/** An NSE equity token: segment (low byte) 1, so the price divisor is 100. */
const RELIANCE_TOKEN = 738561;
const TCS_TOKEN = 2953217;

function quotePacket(
  token: number,
  lastPriceRupees: number,
  lastQuantity: number,
  volume = 0,
): Buffer {
  const packet = Buffer.alloc(44);
  packet.writeInt32BE(token, 0);
  packet.writeInt32BE(Math.round(lastPriceRupees * 100), 4);
  packet.writeInt32BE(lastQuantity, 8);
  packet.writeInt32BE(volume, 16);
  return packet;
}

function fullPacket(
  token: number,
  lastPriceRupees: number,
  lastQuantity: number,
  exchangeSeconds: number,
): Buffer {
  const packet = Buffer.alloc(184);
  packet.writeInt32BE(token, 0);
  packet.writeInt32BE(Math.round(lastPriceRupees * 100), 4);
  packet.writeInt32BE(lastQuantity, 8);
  packet.writeInt32BE(exchangeSeconds, 60);
  return packet;
}

function ltpPacket(token: number, lastPriceRupees: number): Buffer {
  const packet = Buffer.alloc(8);
  packet.writeInt32BE(token, 0);
  packet.writeInt32BE(Math.round(lastPriceRupees * 100), 4);
  return packet;
}

function frame(...packets: Buffer[]): Buffer {
  const header = Buffer.alloc(2);
  header.writeInt16BE(packets.length, 0);

  const parts: Buffer[] = [header];
  for (const packet of packets) {
    const length = Buffer.alloc(2);
    length.writeInt16BE(packet.length, 0);
    parts.push(length, packet);
  }
  return Buffer.concat(parts);
}

describe('parseTickerFrame', () => {
  it('decodes a quote packet into price, quantity and volume', () => {
    const packets = parseTickerFrame(frame(quotePacket(RELIANCE_TOKEN, 2500.75, 12, 1_840_000)));

    expect(packets).toHaveLength(1);
    expect(packets[0]).toEqual({
      instrumentToken: RELIANCE_TOKEN,
      lastPrice: 2500.75,
      lastQuantity: 12,
      exchangeTimestamp: null,
      volumeTraded: 1_840_000,
    });
  });

  it('decodes several packets from one frame', () => {
    const packets = parseTickerFrame(
      frame(quotePacket(RELIANCE_TOKEN, 2500, 5), quotePacket(TCS_TOKEN, 3900.5, 7)),
    );

    expect(packets.map((p) => p.instrumentToken)).toEqual([RELIANCE_TOKEN, TCS_TOKEN]);
    expect(packets.map((p) => p.lastPrice)).toEqual([2500, 3900.5]);
  });

  it('reads the exchange clock from a full packet', () => {
    const seconds = Math.floor(Date.parse('2026-03-02T09:20:00Z') / 1000);
    const [packet] = parseTickerFrame(frame(fullPacket(RELIANCE_TOKEN, 2500, 3, seconds)));

    expect(packet?.exchangeTimestamp).toBe(seconds * 1000);
  });

  it('reports no exchange clock when Kite sends a zero timestamp', () => {
    const [packet] = parseTickerFrame(frame(fullPacket(RELIANCE_TOKEN, 2500, 3, 0)));
    expect(packet?.exchangeTimestamp).toBeNull();
  });

  it('decodes an LTP packet, which carries no quantity', () => {
    const [packet] = parseTickerFrame(frame(ltpPacket(RELIANCE_TOKEN, 2500)));

    expect(packet?.lastPrice).toBe(2500);
    expect(packet?.lastQuantity).toBe(0);
    expect(packet?.volumeTraded).toBeNull();
  });

  it('treats a one-byte heartbeat as carrying no data', () => {
    expect(parseTickerFrame(Buffer.alloc(1))).toEqual([]);
    expect(parseTickerFrame(Buffer.alloc(0))).toEqual([]);
  });

  it('returns what it could read from a truncated frame rather than throwing', () => {
    // Claims two packets, carries one. A transport problem that reconnecting
    // fixes must not take down the feed handler.
    const good = frame(quotePacket(RELIANCE_TOKEN, 2500, 5));
    good.writeInt16BE(2, 0);

    expect(() => parseTickerFrame(good)).not.toThrow();
    expect(parseTickerFrame(good)).toHaveLength(1);
  });

  it('applies the currency-derivative divisor rather than a flat 100', () => {
    // Segment 3 (NSE_CD) quotes to seven decimal places. Dividing by 100 would
    // misprice it by five orders of magnitude.
    const cdToken = (1000 << 8) | 3;
    const packet = Buffer.alloc(44);
    packet.writeInt32BE(cdToken, 0);
    packet.writeInt32BE(875_000_00, 4);

    const [decoded] = parseTickerFrame(frame(packet));
    expect(decoded?.lastPrice).toBeCloseTo(8.75, 6);
  });

  it('identifies index tokens, which print levels rather than trades', () => {
    const indexToken = (256 << 8) | 9;
    expect(isIndexToken(indexToken)).toBe(true);
    expect(isIndexToken(RELIANCE_TOKEN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/** A socket that records what was sent and can be driven from the test. */
class FakeSocket extends EventEmitter implements TickerSocket {
  readonly sent: string[] = [];
  closed = false;
  terminated = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.terminated = true;
  }
}

function tickerWith(overrides: Partial<KiteTickerConfig> = {}) {
  const sockets: FakeSocket[] = [];
  let now = Date.parse('2026-03-02T09:20:00Z');

  const ticker = new KiteTicker({
    apiKey: 'key',
    accessToken: () => 'token',
    symbolFor: (token) =>
      token === RELIANCE_TOKEN ? 'NSE:RELIANCE' : token === TCS_TOKEN ? 'NSE:TCS' : undefined,
    clock: () => now,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...overrides,
  });

  return {
    ticker,
    sockets,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('KiteTicker', () => {
  it('subscribes and sets the mode once connected', () => {
    const { ticker, sockets } = tickerWith();

    ticker.subscribe([RELIANCE_TOKEN, TCS_TOKEN]);
    ticker.start();
    sockets[0]!.emit('open');

    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({ a: 'subscribe', v: [RELIANCE_TOKEN, TCS_TOKEN] }),
      JSON.stringify({ a: 'mode', v: ['full', [RELIANCE_TOKEN, TCS_TOKEN]] }),
    ]);

    ticker.stop();
  });

  it('carries the access token and api key on the connection URL', () => {
    let url = '';
    const { ticker } = tickerWith({
      connect: (requested: string) => {
        url = requested;
        return new FakeSocket();
      },
    });

    ticker.start();
    expect(url).toContain('api_key=key');
    expect(url).toContain('access_token=token');
    ticker.stop();
  });

  it('emits ticks for subscribed instruments and ignores unknown tokens', () => {
    const { ticker, sockets } = tickerWith();
    const ticks: { symbol: string; price: number }[] = [];
    ticker.on('tick', (tick) => ticks.push({ symbol: tick.symbol, price: toRupees(tick.price) }));

    ticker.subscribe([RELIANCE_TOKEN]);
    ticker.start();
    sockets[0]!.emit('open');

    sockets[0]!.emit(
      'message',
      frame(quotePacket(RELIANCE_TOKEN, 2500.5, 10), quotePacket(999999, 100, 1)),
      true,
    );

    expect(ticks).toEqual([{ symbol: 'NSE:RELIANCE', price: 2500.5 }]);
    ticker.stop();
  });

  it('stamps a tick with the exchange clock when the packet carries one', () => {
    const { ticker, sockets } = tickerWith();
    const seconds = Math.floor(Date.parse('2026-03-02T09:19:30Z') / 1000);
    let stamped = 0;
    ticker.on('tick', (tick) => {
      stamped = tick.timestamp;
    });

    ticker.start();
    sockets[0]!.emit('open');
    sockets[0]!.emit('message', frame(fullPacket(RELIANCE_TOKEN, 2500, 4, seconds)), true);

    expect(stamped).toBe(seconds * 1000);
    ticker.stop();
  });

  it('falls back to arrival time when the packet has no exchange clock', () => {
    const { ticker, sockets, now } = tickerWith();
    let stamped = 0;
    ticker.on('tick', (tick) => {
      stamped = tick.timestamp;
    });

    ticker.start();
    sockets[0]!.emit('open');
    sockets[0]!.emit('message', frame(quotePacket(RELIANCE_TOKEN, 2500, 4)), true);

    expect(stamped).toBe(now());
    ticker.stop();
  });

  it('re-subscribes everything after a reconnect', async () => {
    const { ticker, sockets } = tickerWith({ reconnectBaseMs: 1 });

    ticker.subscribe([RELIANCE_TOKEN]);
    ticker.start();
    sockets[0]!.emit('open');
    sockets[0]!.emit('close', 1006, Buffer.alloc(0));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sockets.length).toBeGreaterThan(1);
    sockets[1]!.emit('open');

    // The subscription set is the source of truth, so a drop cannot silently
    // leave an instrument unsubscribed.
    expect(sockets[1]!.sent[0]).toBe(JSON.stringify({ a: 'subscribe', v: [RELIANCE_TOKEN] }));
    ticker.stop();
  });

  it('reconnects a connection that stays open but stops delivering frames', async () => {
    const { ticker, sockets, advance } = tickerWith({
      reconnectBaseMs: 1,
      heartbeatTimeoutMs: 2_000,
    });

    const reasons: string[] = [];
    ticker.on('disconnected', (reason) => reasons.push(reason));

    ticker.start();
    sockets[0]!.emit('open');

    // The socket never closes; it simply goes quiet. This is the failure that
    // is invisible to anything only inspecting connection state.
    advance(5_000);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(reasons[0]).toMatch(/heartbeat/i);
    expect(sockets[0]!.terminated).toBe(true);
    ticker.stop();
  });

  it('stops reconnecting once stopped', async () => {
    const { ticker, sockets } = tickerWith({ reconnectBaseMs: 1 });

    ticker.start();
    sockets[0]!.emit('open');
    ticker.stop();

    const before = sockets.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets).toHaveLength(before);
  });

  it('surfaces error frames sent as JSON on the same socket', () => {
    const { ticker, sockets } = tickerWith();
    const errors: string[] = [];
    ticker.on('error', (error) => errors.push(error.message));

    ticker.start();
    sockets[0]!.emit('open');
    sockets[0]!.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'error', data: 'TokenException' })),
      false,
    );

    expect(errors[0]).toContain('TokenException');
    ticker.stop();
  });
});

// ---------------------------------------------------------------------------
// LiveFeed
// ---------------------------------------------------------------------------

class RecordingCandleRepository implements CandleRepository {
  readonly stored: Candle[] = [];
  failNext = false;

  async upsertMany(candles: readonly Candle[]): Promise<number> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('database unavailable');
    }
    this.stored.push(...candles);
    return candles.length;
  }

  async range(): Promise<Candle[]> {
    return [];
  }

  async latest(): Promise<Candle[]> {
    return [];
  }

  async symbols(): Promise<string[]> {
    return [];
  }
}

/** A ticker stand-in: the feed only ever consumes its events. */
class FakeTicker extends EventEmitter {
  started = false;
  stopped = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }
}

const calendar = new MarketCalendar({ holidays: NSE_HOLIDAYS_2026 });
const SESSION_DAY = '2026-03-02';

function at(minuteOfDay: number, second = 0): Timestamp {
  return fromIst(SESSION_DAY, minuteOfDay) + second * 1000;
}

function buildFeed(interval: Interval = '1m') {
  const ticker = new FakeTicker();
  const candles = new RecordingCandleRepository();
  let now = at(9 * 60 + 20);

  const feed = new LiveFeed({
    // The feed only uses the event surface, which FakeTicker provides in full.
    ticker: ticker as unknown as KiteTicker,
    candles,
    calendar,
    interval,
    flushIntervalMs: 60_000, // long, so flushes are driven explicitly by the test
    clock: () => now,
  });

  return {
    feed,
    ticker,
    candles,
    /**
     * Delivers a tick with the feed's clock set to its timestamp.
     *
     * Ticks arrive at roughly the moment they are printed, and the validator
     * rejects anything meaningfully ahead of the clock — so a harness that let
     * `now` lag would reject every tick and test nothing.
     */
    send: (symbol: string, timestamp: Timestamp, rupees: number, quantity: number) => {
      now = timestamp;
      ticker.emit('tick', { symbol, timestamp, price: fromRupees(rupees), quantity });
    },
    setNow: (timestamp: Timestamp) => {
      now = timestamp;
    },
  };
}

describe('LiveFeed', () => {
  it('assembles ticks into a bar and stores it once the next bucket opens', async () => {
    const { feed, candles, send } = buildFeed();
    feed.start();

    // 09:20 bar
    send('NSE:RELIANCE', at(560, 5), 2500, 10);
    send('NSE:RELIANCE', at(560, 30), 2510, 5);
    send('NSE:RELIANCE', at(560, 50), 2495, 8);
    // first tick of 09:21 closes the 09:20 bar
    send('NSE:RELIANCE', at(561, 2), 2498, 3);

    await feed.stop();

    const bar = candles.stored.find((c) => c.timestamp === at(560));
    expect(bar).toBeDefined();
    expect(toRupees(bar!.open)).toBe(2500);
    expect(toRupees(bar!.high)).toBe(2510);
    expect(toRupees(bar!.low)).toBe(2495);
    expect(toRupees(bar!.close)).toBe(2495);
    expect(bar!.volume).toBe(23);
  });

  it('keeps a separate bar per symbol', async () => {
    const { feed, candles, send } = buildFeed();
    feed.start();

    send('NSE:RELIANCE', at(560, 5), 2500, 1);
    send('NSE:TCS', at(560, 6), 3900, 2);

    await feed.stop();

    const symbols = candles.stored.map((c) => c.symbol).sort();
    expect(symbols).toEqual(['NSE:RELIANCE', 'NSE:TCS']);
  });

  it('ignores ticks printed outside the session', async () => {
    const { feed, candles, send } = buildFeed();
    feed.start();

    // 09:07 is pre-open matching — real prints, but not part of any traded bar.
    send('NSE:RELIANCE', at(9 * 60 + 7), 2400, 5);
    send('NSE:RELIANCE', at(560, 5), 2500, 1);

    await feed.stop();

    expect(candles.stored).toHaveLength(1);
    expect(toRupees(candles.stored[0]!.open)).toBe(2500);
  });

  it('rejects a fat-finger print rather than folding it into the bar', async () => {
    const { feed, candles, send } = buildFeed();
    feed.start();

    send('NSE:RELIANCE', at(560, 5), 2500, 1);
    // 10x the previous price — beyond any NSE price band.
    send('NSE:RELIANCE', at(560, 10), 25000, 1);

    await feed.stop();

    expect(toRupees(candles.stored[0]!.high)).toBe(2500);
  });

  it('flushes the bar in progress on stop, so a mid-session deploy leaves no hole', async () => {
    const { feed, candles, send } = buildFeed();
    feed.start();

    send('NSE:RELIANCE', at(560, 5), 2500, 4);
    expect(candles.stored).toHaveLength(0);

    await feed.stop();

    expect(candles.stored).toHaveLength(1);
    expect(candles.stored[0]!.timestamp).toBe(at(560));
  });

  it('holds bars in memory when the write fails, rather than losing them', async () => {
    const { feed, candles, send } = buildFeed();
    feed.start();

    send('NSE:RELIANCE', at(560, 5), 2500, 4);

    candles.failNext = true;
    await feed.stop();

    // The ticks that built it are gone, so dropping the batch would be a
    // permanent hole in the series.
    expect(candles.stored).toHaveLength(0);
    expect(feed.pendingBars).toBe(1);

    // The next attempt writes it.
    await feed.stop();
    expect(candles.stored).toHaveLength(1);
  });

  it('drops an out-of-order tick without disturbing the open bar', async () => {
    const { feed, candles, send } = buildFeed();
    feed.start();

    send('NSE:RELIANCE', at(560, 30), 2500, 4);
    // Arrives late, from before the previous one — expected across a reconnect.
    send('NSE:RELIANCE', at(560, 10), 2400, 4);

    await feed.stop();

    expect(candles.stored).toHaveLength(1);
    expect(toRupees(candles.stored[0]!.low)).toBe(2500);
  });

  it('ignores ticks after stop', async () => {
    const { feed, candles, send } = buildFeed();
    feed.start();
    await feed.stop();

    send('NSE:RELIANCE', at(560, 5), 2500, 4);
    await feed.stop();

    expect(candles.stored).toHaveLength(0);
  });
});
