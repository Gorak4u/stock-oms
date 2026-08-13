/**
 * Kite Connect v3 streaming quotes.
 *
 * This is the piece that makes intraday trading honest. Everything else reads
 * bars from the `candle` table, and until now the only thing writing them was a
 * poller against Kite's *historical* endpoint — which does not publish the
 * current bar until it has closed, and is rate-limited far below a feed. On
 * daily bars that is invisible. On minute bars it means every decision was made
 * against a bar the market had already moved past.
 *
 * The protocol is binary and undocumented in places, so the parsing is kept
 * separate from the socket: {@link parseTickerFrame} is a pure function over a
 * buffer, which is what the tests exercise. The class around it does nothing but
 * connection lifecycle.
 *
 * Frame layout, all integers big-endian and signed:
 *
 *   [0..1]  int16   number of packets in this frame
 *   then, per packet:
 *   [0..1]  int16   packet length in bytes
 *   [..]    packet  see PACKET_* below
 *
 * A one-byte frame is the server's heartbeat, sent about once a second. It
 * carries no data and exists so that a silent connection can be told from a
 * dead one — which is the whole reason the watchdog below can be strict.
 */

import { EventEmitter } from 'node:events';
import type { Tick, Timestamp } from '../domain/types';
import { fromRupees } from '../domain/money';

/** Packet sizes that identify a mode. Anything else is skipped, not guessed at. */
const PACKET_LTP = 8;
const PACKET_INDEX_QUOTE = 28;
const PACKET_INDEX_FULL = 32;
const PACKET_QUOTE = 44;
const PACKET_FULL = 184;

/**
 * Price divisor by exchange segment, taken from the low byte of the token.
 *
 * Currency derivatives quote to more decimal places than everything else, so a
 * flat divide by 100 would misprice them by four orders of magnitude. This
 * platform trades NSE equity, where the divisor is 100 — the other two are here
 * so that a mistaken subscription is wrong loudly rather than quietly.
 */
const SEGMENT_NSE_CD = 3;
const SEGMENT_BSE_CD = 6;
const SEGMENT_INDICES = 9;

function priceDivisor(instrumentToken: number): number {
  const segment = instrumentToken & 0xff;
  if (segment === SEGMENT_NSE_CD) return 10_000_000;
  if (segment === SEGMENT_BSE_CD) return 10_000;
  return 100;
}

export function isIndexToken(instrumentToken: number): boolean {
  return (instrumentToken & 0xff) === SEGMENT_INDICES;
}

/** One decoded packet, before it is matched to a symbol. */
export interface TickerPacket {
  readonly instrumentToken: number;
  /** Last traded price, in rupees. */
  readonly lastPrice: number;
  /** Quantity at the last print. Zero in LTP mode and for indices, which do not trade. */
  readonly lastQuantity: number;
  /** Exchange timestamp in epoch ms, when the mode carries one. */
  readonly exchangeTimestamp: Timestamp | null;
  /** Cumulative volume for the day, when the mode carries it. */
  readonly volumeTraded: number | null;
}

/**
 * Decodes one binary frame into packets.
 *
 * Malformed input returns what it could read rather than throwing: a truncated
 * frame is a transport problem that reconnecting fixes, and taking down the
 * feed handler over one bad buffer would turn a recoverable blip into an
 * outage. A frame shorter than its own header yields nothing.
 */
export function parseTickerFrame(frame: Buffer): TickerPacket[] {
  // The heartbeat. Not an error, and not data.
  if (frame.length <= 2) return [];

  const count = frame.readInt16BE(0);
  if (count <= 0) return [];

  const packets: TickerPacket[] = [];
  let offset = 2;

  for (let i = 0; i < count; i += 1) {
    if (offset + 2 > frame.length) break;
    const length = frame.readInt16BE(offset);
    offset += 2;

    if (length <= 0 || offset + length > frame.length) break;

    const packet = decodePacket(frame.subarray(offset, offset + length));
    if (packet) packets.push(packet);
    offset += length;
  }

  return packets;
}

function decodePacket(packet: Buffer): TickerPacket | null {
  const length = packet.length;
  if (length < PACKET_LTP) return null;

  const instrumentToken = packet.readInt32BE(0);
  const divisor = priceDivisor(instrumentToken);
  const lastPrice = packet.readInt32BE(4) / divisor;

  // Indices publish a level, not a trade: there is no quantity and no volume,
  // and treating their zero-quantity prints as trades would produce bars whose
  // volume is meaninglessly zero rather than absent.
  if (length === PACKET_INDEX_QUOTE || length === PACKET_INDEX_FULL) {
    return {
      instrumentToken,
      lastPrice,
      lastQuantity: 0,
      exchangeTimestamp:
        length === PACKET_INDEX_FULL ? secondsToMs(packet.readInt32BE(28)) : null,
      volumeTraded: null,
    };
  }

  if (length === PACKET_LTP) {
    return {
      instrumentToken,
      lastPrice,
      lastQuantity: 0,
      exchangeTimestamp: null,
      volumeTraded: null,
    };
  }

  if (length < PACKET_QUOTE) return null;

  const lastQuantity = packet.readInt32BE(8);
  const volumeTraded = packet.readInt32BE(16);

  // Only full mode carries the exchange's own clock. Everything coarser is
  // stamped on arrival by the caller, which is less accurate but never wrong
  // about ordering.
  const exchangeTimestamp =
    length >= PACKET_FULL ? secondsToMs(packet.readInt32BE(60)) : null;

  return { instrumentToken, lastPrice, lastQuantity, exchangeTimestamp, volumeTraded };
}

function secondsToMs(seconds: number): Timestamp | null {
  // Kite sends 0 when it has no timestamp for the instrument yet.
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/** Subscription detail level. `full` is the only one carrying an exchange clock. */
export type TickerMode = 'ltp' | 'quote' | 'full';

/**
 * The subset of `ws` this needs.
 *
 * Declared structurally so tests can drive the connection lifecycle with a
 * plain EventEmitter instead of standing up a WebSocket server.
 */
export interface TickerSocket {
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate?(): void;
  removeAllListeners(): void;
}

export interface KiteTickerConfig {
  readonly apiKey: string;
  /** Resolved per connection, so a token refreshed mid-session is picked up on reconnect. */
  readonly accessToken: () => string;
  /** Maps an instrument token to the platform's `EXCHANGE:SYMBOL`. */
  readonly symbolFor: (instrumentToken: number) => string | undefined;
  readonly url?: string;
  readonly mode?: TickerMode;
  /**
   * Reconnect after this long without any frame, heartbeat included.
   *
   * Kite heartbeats about once a second, so silence for this long means the
   * connection is dead in a way TCP has not noticed yet. That state is the
   * dangerous one: the socket reports open, no ticks arrive, and a strategy
   * keeps deciding against the last bar it saw.
   */
  readonly heartbeatTimeoutMs?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly clock?: () => Timestamp;
  readonly connect?: (url: string) => TickerSocket;
}

/**
 * Typed events.
 *
 * Declaration-merged onto the class below so `on('tick', …)` gets a typed
 * listener instead of `(...args: any[])`. The lint rule against merging a class
 * with an interface is aimed at accidentally widening a class's shape; here it
 * is the documented way to type an EventEmitter, and the interface adds only
 * overloads of a method the class already has.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface KiteTicker {
  on(event: 'tick', listener: (tick: Tick) => void): this;
  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: (reason: string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

/**
 * A reconnecting Kite quote stream.
 *
 * Emits `tick` for every packet that resolves to a subscribed symbol. Packets
 * for unknown tokens are dropped silently — the exchange occasionally sends
 * instruments nobody asked for, and that is not worth an alert.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class KiteTicker extends EventEmitter {
  private socket: TickerSocket | null = null;
  private tokens = new Set<number>();
  private running = false;
  private connected = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;

  private readonly mode: TickerMode;
  private readonly heartbeatTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly clock: () => Timestamp;

  constructor(private readonly config: KiteTickerConfig) {
    super();
    this.mode = config.mode ?? 'full';
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 10_000;
    this.reconnectBaseMs = config.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = config.reconnectMaxMs ?? 60_000;
    this.clock = config.clock ?? (() => Date.now());
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Epoch ms of the last frame received, heartbeats included. */
  get lastFrameTimestamp(): Timestamp {
    return this.lastFrameAt;
  }

  /**
   * Adds instruments to the subscription.
   *
   * Safe before `start()` and while connected: the set is the source of truth
   * and is re-sent in full on every reconnect, so a subscription can never be
   * left behind by a connection drop.
   */
  subscribe(instrumentTokens: readonly number[]): void {
    for (const token of instrumentTokens) this.tokens.add(token);
    if (this.connected) this.sendSubscription(instrumentTokens);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  /** Stops reconnecting and closes. Safe to call more than once. */
  stop(): void {
    this.running = false;
    this.clearTimers();
    this.connected = false;

    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // Already gone. Nothing to do, and nothing worth reporting.
      }
    }
  }

  private url(): string {
    const base = this.config.url ?? 'wss://ws.kite.trade';
    const params = new URLSearchParams({
      api_key: this.config.apiKey,
      access_token: this.config.accessToken(),
    });
    return `${base}?${params.toString()}`;
  }

  private open(): void {
    if (!this.running) return;

    let socket: TickerSocket;
    try {
      socket = this.config.connect
        ? this.config.connect(this.url())
        : defaultConnect(this.url());
    } catch (error) {
      // A synchronous failure to construct the socket — a bad URL, a missing
      // token — must still go through the backoff, or this would spin.
      this.emit('error', asError(error));
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.on('open', () => {
      this.connected = true;
      this.attempt = 0;
      this.lastFrameAt = this.clock();
      if (this.tokens.size > 0) this.sendSubscription([...this.tokens]);
      this.startWatchdog();
      this.emit('connected');
    });

    socket.on('message', (data, isBinary) => {
      this.lastFrameAt = this.clock();
      if (isBinary) this.onBinary(data);
      else this.onText(data);
    });

    socket.on('close', (code) => this.onDisconnect(`socket closed (${code})`));
    socket.on('error', (error) => {
      this.emit('error', error);
      this.onDisconnect(error.message);
    });
  }

  private onBinary(data: unknown): void {
    const frame = toBuffer(data);
    if (!frame) return;

    for (const packet of parseTickerFrame(frame)) {
      const symbol = this.config.symbolFor(packet.instrumentToken);
      if (!symbol) continue;

      // Prefer the exchange's clock. Falling back to arrival time is a real
      // loss of accuracy under load, but a tick with no timestamp at all
      // cannot be bucketed into a bar.
      const timestamp = packet.exchangeTimestamp ?? this.clock();

      let price;
      try {
        price = fromRupees(packet.lastPrice);
      } catch {
        // A non-finite price would poison every bar it touched.
        continue;
      }

      this.emit('tick', {
        symbol,
        timestamp,
        price,
        quantity: packet.lastQuantity,
      } satisfies Tick);
    }
  }

  private onText(data: unknown): void {
    // Kite sends order postbacks and errors as JSON on the same socket. Order
    // state is reconciled against the broker's own book, so postbacks are not
    // load-bearing here; errors are worth surfacing.
    const text = toBuffer(data)?.toString('utf8');
    if (!text) return;

    try {
      const message = JSON.parse(text) as { type?: string; data?: unknown };
      if (message.type === 'error') {
        this.emit('error', new Error(`ticker error: ${JSON.stringify(message.data)}`));
      }
    } catch {
      // Not JSON. Nothing on this channel is required for correctness.
    }
  }

  private sendSubscription(tokens: readonly number[]): void {
    if (tokens.length === 0) return;
    const list = [...tokens];
    this.trySend(JSON.stringify({ a: 'subscribe', v: list }));
    this.trySend(JSON.stringify({ a: 'mode', v: [this.mode, list] }));
  }

  private trySend(payload: string): void {
    try {
      this.socket?.send(payload);
    } catch (error) {
      this.emit('error', asError(error));
    }
  }

  /**
   * Reconnects a connection that has gone quiet.
   *
   * An open socket that stopped delivering is worse than a closed one, because
   * nothing else in the system can tell the difference — the health check sees
   * a connected feed and stale bars, and the two look like a slow market.
   */
  private startWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setInterval(() => {
      if (this.clock() - this.lastFrameAt > this.heartbeatTimeoutMs) {
        this.onDisconnect('no frames received within the heartbeat timeout');
      }
    }, Math.max(1_000, Math.floor(this.heartbeatTimeoutMs / 2)));
  }

  private onDisconnect(reason: string): void {
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.removeAllListeners();
      try {
        // terminate() drops it now; close() waits for a handshake the other end
        // may never complete, which is exactly the case the watchdog catches.
        if (socket.terminate) socket.terminate();
        else socket.close();
      } catch {
        // Already gone.
      }
    }

    this.clearWatchdog();

    if (!this.connected && this.reconnectTimer) return;
    this.connected = false;
    this.emit('disconnected', reason);

    if (this.running) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.attempt);
    this.attempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);

    // Never hold the process open for a reconnect; shutdown should not wait.
    this.reconnectTimer.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private clearTimers(): void {
    this.clearWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Loaded lazily so the module can be imported — and its parser tested — in an
 * environment without `ws` present, and so the browser bundle never reaches it.
 */
function defaultConnect(url: string): TickerSocket {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebSocket } = require('ws') as { WebSocket: new (url: string) => TickerSocket };
  return new WebSocket(url);
}
