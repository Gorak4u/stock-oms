/**
 * Kite access-token lifecycle.
 *
 * Kite Connect access tokens expire every morning, around 07:30 IST, and there
 * is no refresh token — re-authentication requires a human to visit a login URL
 * and hand back a `request_token`. That is a broker constraint, not something
 * this code can design away.
 *
 * What it *can* do is stop the expiry from being a silent outage. Previously
 * the token was read once from the environment at boot, which meant the process
 * came up healthy every morning, failed every broker call, and only announced
 * it through a degraded health check that nobody was watching at 07:30.
 *
 * So:
 *
 * - The live token is held here, not captured in a closure at construction, so
 *   supplying a new one takes effect without a restart.
 * - It is persisted, so a restart during the day reuses the token instead of
 *   demanding a fresh login.
 * - Expiry is *predicted* from the clock and *detected* from `TokenException`,
 *   whichever comes first, and both raise a critical alert naming the login URL.
 */

import { createHash } from 'node:crypto';
import type { Timestamp } from '../domain/types';
import type { RuntimeStateRepository } from '../persistence/ports';
import type { AlertManager } from '../monitoring/metrics';

const STATE_KEY = 'broker:kite:session';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Kite invalidates tokens daily at ~07:30 IST. */
const EXPIRY_IST_HOUR = 7;
const EXPIRY_IST_MINUTE = 30;

export interface StoredSession {
  readonly accessToken: string;
  readonly obtainedAt: Timestamp;
  /** Kite's own user id, kept for the audit trail. */
  readonly userId?: string;
}

export interface KiteSessionConfig {
  readonly apiKey: string;
  /** Required only to exchange a request token; reading a stored one does not need it. */
  readonly apiSecret?: string;
  readonly state?: RuntimeStateRepository;
  readonly alerts?: AlertManager;
  readonly baseUrl?: string;
  readonly loginBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Timestamp;
}

/**
 * The next 07:30 IST strictly after `now`.
 *
 * Computed in IST rather than the host's zone: a container running in UTC
 * would otherwise expire the token seventeen and a half hours late, which is
 * to say during the trading session rather than before it.
 */
export function nextTokenExpiry(now: Timestamp): Timestamp {
  const ist = new Date(now + IST_OFFSET_MS);

  const expiryUtc = Date.UTC(
    ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(),
    EXPIRY_IST_HOUR, EXPIRY_IST_MINUTE, 0, 0,
  ) - IST_OFFSET_MS;

  return expiryUtc > now ? expiryUtc : expiryUtc + 24 * 60 * 60 * 1000;
}

export class KiteAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KiteAuthError';
  }
}

export class KiteSession {
  private session: StoredSession | null = null;
  private invalidatedAt: Timestamp | null = null;
  private readonly clock: () => Timestamp;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: KiteSessionConfig) {
    this.clock = config.clock ?? (() => Date.now());
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  /** The URL an operator visits to obtain a fresh `request_token`. */
  get loginUrl(): string {
    const base = this.config.loginBaseUrl ?? 'https://kite.zerodha.com/connect/login';
    return `${base}?v=3&api_key=${encodeURIComponent(this.config.apiKey)}`;
  }

  /**
   * Loads a persisted token, seeding from `initialToken` when there is none.
   *
   * A stored token that has already passed its daily expiry is discarded rather
   * than handed out, so the process reports "needs login" at startup instead of
   * discovering it on the first order of the day.
   */
  async load(initialToken?: string): Promise<boolean> {
    const stored = await this.config.state?.get<StoredSession>(STATE_KEY);
    const now = this.clock();

    if (stored?.accessToken && nextTokenExpiry(stored.obtainedAt) > now) {
      this.session = stored;
      this.invalidatedAt = null;
      return true;
    }

    if (initialToken) {
      // Assume an environment-supplied token was obtained just now: it is the
      // operator asserting it is current, and the daily expiry still bounds it.
      await this.adopt({ accessToken: initialToken, obtainedAt: now });
      return true;
    }

    this.session = null;
    return false;
  }

  /** The current token, or throws — callers must not paper over a missing session. */
  accessToken(): string {
    const token = this.currentToken();
    if (!token) {
      throw new KiteAuthError(
        `no valid Kite access token — log in at ${this.loginUrl} and POST the ` +
          'request_token to /api/broker/session',
      );
    }
    return token;
  }

  /** The current token or null. For health checks, which must not throw. */
  currentToken(): string | null {
    if (!this.session || this.invalidatedAt !== null) return null;
    if (nextTokenExpiry(this.session.obtainedAt) <= this.clock()) return null;
    return this.session.accessToken;
  }

  get isValid(): boolean {
    return this.currentToken() !== null;
  }

  /** When the current token lapses, or null when there is none. */
  get expiresAt(): Timestamp | null {
    return this.session ? nextTokenExpiry(this.session.obtainedAt) : null;
  }

  /**
   * Exchanges a `request_token` from the login redirect for an access token.
   *
   * The checksum is `sha256(api_key + request_token + api_secret)` — Kite's
   * scheme for proving the caller holds the secret without sending it.
   */
  async exchangeRequestToken(requestToken: string): Promise<StoredSession> {
    if (!this.config.apiSecret) {
      throw new KiteAuthError('KITE_API_SECRET is required to exchange a request token');
    }
    if (!this.fetchImpl) {
      throw new KiteAuthError('no fetch implementation available');
    }

    const checksum = createHash('sha256')
      .update(`${this.config.apiKey}${requestToken}${this.config.apiSecret}`)
      .digest('hex');

    const response = await this.fetchImpl(
      `${this.config.baseUrl ?? 'https://api.kite.trade'}/session/token`,
      {
        method: 'POST',
        headers: {
          'X-Kite-Version': '3',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          api_key: this.config.apiKey,
          request_token: requestToken,
          checksum,
        }).toString(),
      },
    );

    let payload: { status?: string; message?: string; data?: { access_token?: string; user_id?: string } };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new KiteAuthError(`unparseable session response (HTTP ${response.status})`);
    }

    const accessToken = payload.data?.access_token;
    if (!response.ok || payload.status === 'error' || !accessToken) {
      throw new KiteAuthError(
        `token exchange failed: ${payload.message ?? `HTTP ${response.status}`}`,
      );
    }

    const session: StoredSession = {
      accessToken,
      obtainedAt: this.clock(),
      ...(payload.data?.user_id ? { userId: payload.data.user_id } : {}),
    };

    await this.adopt(session);
    return session;
  }

  /** Accepts an access token obtained elsewhere (a manual login, a helper script). */
  async adoptAccessToken(accessToken: string): Promise<StoredSession> {
    const session: StoredSession = { accessToken, obtainedAt: this.clock() };
    await this.adopt(session);
    return session;
  }

  private async adopt(session: StoredSession): Promise<void> {
    this.session = session;
    this.invalidatedAt = null;
    await this.config.state?.set(STATE_KEY, session, session.obtainedAt);

    await this.config.alerts?.dispatch({
      severity: 'info',
      title: 'Kite session established',
      detail: `token valid until ${new Date(nextTokenExpiry(session.obtainedAt)).toISOString()}`,
      at: session.obtainedAt,
    });
  }

  /**
   * Marks the token dead after the broker rejected it.
   *
   * Critical rather than warning, and deliberately not de-duplicated away: with
   * no valid token the platform cannot place, cancel, or even *see* an order,
   * so a resting position is unmanaged until someone logs in.
   */
  async invalidate(reason: string): Promise<void> {
    if (this.invalidatedAt !== null) return;

    this.invalidatedAt = this.clock();
    await this.config.state?.set(STATE_KEY, null, this.invalidatedAt);

    await this.config.alerts?.dispatch({
      severity: 'critical',
      title: 'Kite session expired — re-authentication required',
      detail: `${reason}. Log in at ${this.loginUrl} and POST the request_token to /api/broker/session`,
      at: this.invalidatedAt,
    });
  }
}
