/**
 * Trade reconciliation.
 *
 * The broker is the authority on what the account actually holds. The platform
 * keeps its own view for speed and for risk decisions, and the two *will*
 * diverge — a dropped websocket frame, a fill during a restart, a manual
 * order placed in the broker's own app.
 *
 * A silent divergence is the dangerous case: the risk engine sizes against a
 * position that is not what the account holds, so its limits stop meaning what
 * they claim. Reconciliation finds those divergences and, crucially, does not
 * try to be clever about them — it records a break for a human and, where the
 * fix is unambiguous, adopts the broker's number.
 */

import type { BrokerConnector } from '../execution/broker';
import type { Portfolio } from '../execution/portfolio';
import type { Fill, Timestamp } from '../domain/types';
import { isTerminal } from '../domain/types';
import { abs, ratio, type Paise } from '../domain/money';
import type { OrderRepository, ReconciliationRepository, FillRepository } from '../persistence/ports';
import type { AlertManager } from './metrics';

export interface ReconciliationResult {
  readonly checkedOrders: number;
  readonly ordersUpdated: number;
  readonly fillsAdopted: number;
  readonly breaks: readonly { orderId: string | null; detail: string }[];
  readonly cashDelta: Paise;
}

export interface ReconcilerConfig {
  readonly broker: BrokerConnector;
  readonly orders: OrderRepository;
  readonly fills: FillRepository;
  readonly breaks: ReconciliationRepository;
  readonly portfolio: Portfolio;
  readonly alerts?: AlertManager;
  /**
   * Cash difference tolerated before a break is raised, as a fraction of
   * equity. Small differences are normal — charges settle asynchronously.
   */
  readonly cashToleranceFraction?: number;
}

export class Reconciler {
  private readonly cashToleranceFraction: number;

  constructor(private readonly config: ReconcilerConfig) {
    this.cashToleranceFraction = config.cashToleranceFraction ?? 0.005;
  }

  /**
   * One reconciliation pass.
   *
   * Order state is adopted from the broker where it differs. Fills the
   * platform never saw are folded into the portfolio — that is the case a
   * dropped websocket frame produces, and leaving it unfixed means trading
   * against a position that does not exist.
   */
  async run(since: Timestamp, now: Timestamp = Date.now()): Promise<ReconciliationResult> {
    const breaks: { orderId: string | null; detail: string }[] = [];
    let ordersUpdated = 0;
    let fillsAdopted = 0;

    const open = await this.config.orders.findOpen();

    for (const order of open) {
      if (!order.brokerOrderId) {
        // Staged but never acknowledged. There is nothing to query, and
        // resubmitting could duplicate — this needs a human.
        if (order.status === 'PENDING_NEW') {
          const detail =
            `order ${order.id} is PENDING_NEW with no broker id; ` +
            'confirm against the broker order book before resubmitting';
          breaks.push({ orderId: order.id, detail });
          await this.config.breaks.record({ orderId: order.id, detail, detectedAt: now });
        }
        continue;
      }

      let remote;
      try {
        remote = await this.config.broker.getOrder(order.brokerOrderId);
      } catch (error) {
        const detail = `could not fetch ${order.brokerOrderId}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        breaks.push({ orderId: order.id, detail });
        continue;
      }

      if (!remote) {
        const detail = `broker has no record of order ${order.brokerOrderId}`;
        breaks.push({ orderId: order.id, detail });
        await this.config.breaks.record({ orderId: order.id, detail, detectedAt: now });
        continue;
      }

      if (remote.status !== order.status || remote.filledQuantity !== order.filledQuantity) {
        await this.config.orders.update({
          ...order,
          status: remote.status,
          filledQuantity: remote.filledQuantity,
          ...(remote.averageFillPrice !== undefined
            ? { averageFillPrice: remote.averageFillPrice }
            : {}),
          updatedAt: now,
        });
        ordersUpdated += 1;
      }
    }

    // --- fills the platform never saw -------------------------------------
    let brokerFills: Fill[];
    try {
      brokerFills = await this.config.broker.getFills(since);
    } catch (error) {
      brokerFills = [];
      breaks.push({
        orderId: null,
        detail: `could not fetch fills: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    for (const brokerFill of brokerFills) {
      // Broker fills carry the broker's order id. Resolve it to the platform's
      // before storing, or the fill is attributed to nothing and — while the
      // fill table still had a foreign key — could not be stored at all.
      const matched = await this.config.orders.findByBrokerOrderId(brokerFill.orderId);
      const fill: Fill = matched
        ? { ...brokerFill, orderId: matched.id, brokerOrderId: brokerFill.orderId }
        : { ...brokerFill, brokerOrderId: brokerFill.orderId };

      const stored = await this.config.fills.append(fill);
      if (!stored) continue;

      // append() returning true means this fill is new to us — the portfolio
      // has not seen it either.
      this.config.portfolio.applyFill(fill);
      fillsAdopted += 1;

      const detail =
        `adopted an unseen fill: ${fill.side} ${fill.quantity} ${fill.symbol} ` +
        `at ${fill.price} (order ${fill.orderId})`;
      breaks.push({ orderId: fill.orderId, detail });
      await this.config.breaks.record({ orderId: fill.orderId, detail, detectedAt: now });
    }

    // --- cash ------------------------------------------------------------
    let cashDelta = 0 as Paise;
    try {
      const brokerCash = await this.config.broker.getAvailableCash();
      cashDelta = (brokerCash - this.config.portfolio.cash) as Paise;

      const equity = this.config.portfolio.equity;
      const tolerance = Math.abs(equity * this.cashToleranceFraction);

      if (abs(cashDelta) > tolerance) {
        const detail =
          `cash differs from the broker by ${cashDelta} paise ` +
          `(${(ratio(abs(cashDelta), equity || (1 as Paise)) * 100).toFixed(3)}% of equity)`;
        breaks.push({ orderId: null, detail });
        await this.config.breaks.record({ orderId: null, detail, detectedAt: now });
      }
    } catch {
      // Margin endpoints are frequently unavailable outside market hours;
      // not being able to check cash is not itself a break.
    }

    if (breaks.length > 0 && this.config.alerts) {
      await this.config.alerts.dispatch({
        severity: fillsAdopted > 0 ? 'critical' : 'warning',
        title: 'Reconciliation breaks detected',
        detail: breaks.map((b) => b.detail).join('; '),
        at: now,
        context: { breakCount: breaks.length, fillsAdopted, ordersUpdated },
      });
    }

    return {
      checkedOrders: open.length,
      ordersUpdated,
      fillsAdopted,
      breaks,
      cashDelta,
    };
  }
}

export { isTerminal };
