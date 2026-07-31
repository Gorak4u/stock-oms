/**
 * NSE trading calendar.
 *
 * India does not observe daylight saving, so IST is a fixed UTC+05:30 offset
 * and civil-date arithmetic can be done by shifting the epoch rather than by
 * pulling in a timezone database.
 *
 * Holidays are data, not code: the exchange publishes the list annually and it
 * is injected through {@link MarketCalendar}'s constructor so a wrong or stale
 * list can be corrected without a deploy.
 */

import type { Timestamp } from '../domain/types';

export const IST_OFFSET_MINUTES = 330;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` in IST. */
export type IsoDate = string;

export interface SessionWindow {
  readonly open: Timestamp;
  readonly close: Timestamp;
}

export interface CalendarConfig {
  /** Full-day exchange holidays, `YYYY-MM-DD` in IST. */
  readonly holidays: readonly IsoDate[];
  /** Continuous-trading session in IST minutes past midnight. Default 09:15–15:30. */
  readonly sessionOpenMinute?: number;
  readonly sessionCloseMinute?: number;
  /** Sessions that deviate from the default (muhurat trading, shortened days). */
  readonly specialSessions?: Readonly<Record<IsoDate, { openMinute: number; closeMinute: number }>>;
}

export const DEFAULT_SESSION_OPEN_MINUTE = 9 * 60 + 15;
export const DEFAULT_SESSION_CLOSE_MINUTE = 15 * 60 + 30;

/** Converts an epoch timestamp to the IST civil date it falls on. */
export function toIstDate(timestamp: Timestamp): IsoDate {
  const shifted = new Date(timestamp + IST_OFFSET_MINUTES * MS_PER_MINUTE);
  return shifted.toISOString().slice(0, 10);
}

/** Minutes past IST midnight for an epoch timestamp. */
export function toIstMinuteOfDay(timestamp: Timestamp): number {
  const shifted = new Date(timestamp + IST_OFFSET_MINUTES * MS_PER_MINUTE);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** Epoch timestamp for an IST civil date at a given minute past midnight. */
export function fromIst(date: IsoDate, minuteOfDay: number): Timestamp {
  const midnightUtc = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(midnightUtc)) {
    throw new Error(`invalid ISO date: ${date}`);
  }
  return midnightUtc + (minuteOfDay - IST_OFFSET_MINUTES) * MS_PER_MINUTE;
}

function addDays(date: IsoDate, days: number): IsoDate {
  const base = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(base + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function dayOfWeek(date: IsoDate): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

export class MarketCalendar {
  private readonly holidays: ReadonlySet<IsoDate>;
  private readonly openMinute: number;
  private readonly closeMinute: number;
  private readonly specialSessions: Readonly<
    Record<IsoDate, { openMinute: number; closeMinute: number }>
  >;

  constructor(config: CalendarConfig) {
    this.holidays = new Set(config.holidays);
    this.openMinute = config.sessionOpenMinute ?? DEFAULT_SESSION_OPEN_MINUTE;
    this.closeMinute = config.sessionCloseMinute ?? DEFAULT_SESSION_CLOSE_MINUTE;
    this.specialSessions = config.specialSessions ?? {};

    if (this.openMinute >= this.closeMinute) {
      throw new Error('session open must precede session close');
    }
  }

  isWeekend(date: IsoDate): boolean {
    const day = dayOfWeek(date);
    return day === 0 || day === 6;
  }

  isHoliday(date: IsoDate): boolean {
    return this.holidays.has(date);
  }

  isTradingDay(date: IsoDate): boolean {
    if (this.specialSessions[date]) return true;
    return !this.isWeekend(date) && !this.isHoliday(date);
  }

  /** The continuous-trading window for a date, or `null` if the market is shut. */
  sessionFor(date: IsoDate): SessionWindow | null {
    if (!this.isTradingDay(date)) return null;
    const special = this.specialSessions[date];
    const openMinute = special?.openMinute ?? this.openMinute;
    const closeMinute = special?.closeMinute ?? this.closeMinute;
    return { open: fromIst(date, openMinute), close: fromIst(date, closeMinute) };
  }

  /** True while continuous trading is running. The close minute itself is exclusive. */
  isMarketOpen(timestamp: Timestamp): boolean {
    const session = this.sessionFor(toIstDate(timestamp));
    if (!session) return false;
    return timestamp >= session.open && timestamp < session.close;
  }

  nextTradingDay(date: IsoDate): IsoDate {
    let cursor = addDays(date, 1);
    // A gap longer than this means the holiday list is corrupt, not that the
    // exchange is closed — fail loudly rather than spin.
    for (let i = 0; i < 30; i += 1) {
      if (this.isTradingDay(cursor)) return cursor;
      cursor = addDays(cursor, 1);
    }
    throw new Error(`no trading day found within 30 days after ${date}`);
  }

  previousTradingDay(date: IsoDate): IsoDate {
    let cursor = addDays(date, -1);
    for (let i = 0; i < 30; i += 1) {
      if (this.isTradingDay(cursor)) return cursor;
      cursor = addDays(cursor, -1);
    }
    throw new Error(`no trading day found within 30 days before ${date}`);
  }

  /** Every trading day in `[from, to]`, inclusive. */
  tradingDaysBetween(from: IsoDate, to: IsoDate): IsoDate[] {
    if (from > to) return [];
    const days: IsoDate[] = [];
    let cursor = from;
    while (cursor <= to) {
      if (this.isTradingDay(cursor)) days.push(cursor);
      cursor = addDays(cursor, 1);
    }
    return days;
  }

  /**
   * Minutes remaining in the session.
   *
   * Intraday (`MIS`) positions are force-squared-off by the broker near the
   * close, so strategies use this to stop opening positions they would only
   * have to unwind minutes later.
   */
  minutesToClose(timestamp: Timestamp): number {
    const session = this.sessionFor(toIstDate(timestamp));
    if (!session || timestamp >= session.close) return 0;
    return Math.max(0, Math.floor((session.close - timestamp) / MS_PER_MINUTE));
  }
}

/**
 * NSE trading holidays.
 *
 * Verify against the exchange circular each year before trading against them —
 * these are a development default, not an authoritative source.
 */
export const NSE_HOLIDAYS_2026: readonly IsoDate[] = [
  '2026-01-26', // Republic Day
  '2026-03-04', // Holi
  '2026-03-21', // Id-ul-Fitr
  '2026-03-26', // Ram Navami
  '2026-03-31', // Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-27', // Bakri Id
  '2026-06-26', // Muharram
  '2026-08-15', // Independence Day
  '2026-08-26', // Ganesh Chaturthi
  '2026-10-02', // Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-09', // Diwali Balipratipada
  '2026-11-24', // Guru Nanak Jayanti
  '2026-12-25', // Christmas
];
