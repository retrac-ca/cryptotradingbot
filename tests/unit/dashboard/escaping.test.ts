import { describe, it, expect } from 'vitest';
import { renderMarket } from '../../../web/src/views/market.js';
import { renderOrders } from '../../../web/src/views/orders.js';
import { renderOverview } from '../../../web/src/views/overview.js';
import { renderPortfolio } from '../../../web/src/views/portfolio.js';
import {
  emptyReconciliationState,
  renderReconciliation,
} from '../../../web/src/views/reconciliation.js';
import { renderSystem } from '../../../web/src/views/system.js';

const PROV = { kind: 'managed_state' as const, asOfMs: 1, fetchedAtMs: 1, stale: false };
const MALICIOUS = '<img src=x onerror=alert(1)>';
const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';

function expectSafe(html: string): void {
  // The raw payload must never appear as markup; its escaped form is expected.
  expect(html).not.toContain('<img');
  expect(html).toContain(ESCAPED);
}

function maliciousRealm() {
  return {
    realm: 'paper',
    status: MALICIOUS,
    provenance: PROV,
    cash: { [MALICIOUS]: '1.00000000' },
    positions: [
      {
        symbol: MALICIOUS,
        quantity: '1.00000000',
        averageEntryPrice: '1.00000000',
        costBasis: '0.00000000',
        realizedPnl: '0.00000000',
        feesPaid: '0.00000000',
        entryAnchorPrice: null,
        source: MALICIOUS,
        sourceQuantities: { BOT: '1.00000000', EXTERNAL_AUTHORIZED: '0.00000000' },
      },
    ],
    externalSnapshot: { [MALICIOUS]: '1.00000000' },
    authorizedExternal: [MALICIOUS],
    reserved: null,
    orderReservations: null,
    appliedExecutions: null,
    liveOrderAttestations: null,
    manualSettlements: null,
    peakEquity: '1.00000000',
    realizedPnl: '0.00000000',
    dailyRealizedPnl: '0.00000000',
    dailyRealizedDayKey: MALICIOUS,
    totalFees: '0.00000000',
  };
}

function maliciousSystem() {
  return {
    capturedAtMs: 1,
    config: {
      version: MALICIOUS,
      tradingMode: 'paper',
      exchange: MALICIOUS,
      killSwitch: false,
      enableAuthenticatedReads: false,
      strategy: MALICIOUS,
      timeframe: MALICIOUS,
      tradingPairs: [MALICIOUS],
      universeMarkets: [MALICIOUS],
    },
    init: { status: 'OK', paper: true, live: true },
    lock: { held: false },
    recovery: {
      status: 'READY',
      reasons: [MALICIOUS],
      unresolvedOrders: [MALICIOUS],
      unresolvedReservations: [],
      unresolvedIntents: [],
      crossFileIssues: [MALICIOUS],
      requiresExchangeRead: false,
    },
    provenance: PROV,
  };
}

describe('dashboard rendering escapes server-controlled strings', () => {
  it('orders: IDs, symbols, status, fees, and counts', () => {
    const orders = {
      status: 'OK',
      provenance: PROV,
      orders: [
        {
          clientOrderId: MALICIOUS,
          exchangeOrderId: MALICIOUS,
          symbol: MALICIOUS,
          side: 'SELL',
          type: 'limit',
          status: MALICIOUS,
          quantity: '1.00000000',
          filledQuantity: '0.00000000',
          averagePrice: null,
          limitPrice: '1.00000000',
          fills: [
            {
              price: '1.00000000',
              quantity: '1.00000000',
              fee: '0.00000000',
              feeCurrency: MALICIOUS,
              feeProductId: null,
              executionId: MALICIOUS,
              timestampMs: 1,
            },
          ],
          fee: '0.00000000',
          feeCurrency: MALICIOUS,
          reason: MALICIOUS,
          createdAtMs: 1,
          updatedAtMs: 1,
          resolution: {
            kind: MALICIOUS,
            operator: MALICIOUS,
            reason: MALICIOUS,
            resolvedAtMs: 1,
            accountingAuthority: 'operator_attestation',
            provenanceProof: false,
            exchangeOrderId: MALICIOUS,
            evidence: MALICIOUS,
          },
        },
      ],
      unresolvedCount: MALICIOUS as unknown as number,
      totalCount: 1,
    };
    expectSafe(renderOrders(orders as never, MALICIOUS));
  });

  it('portfolio: realm status, symbols, currency keys, sources', () => {
    const realm = maliciousRealm();
    expectSafe(renderPortfolio({ paper: realm, live: realm } as never, MALICIOUS));
  });

  it('overview: version, mode, market symbol, realm status', () => {
    const realm = maliciousRealm();
    const market = {
      status: 'OK',
      provenance: PROV,
      symbol: MALICIOUS,
      last: '1.00000000',
      bid: '1.00000000',
      ask: '1.00000000',
      spread: '0.00000000',
      spreadPct: '0.00000000',
      quoteTimestampMs: 1,
      observedAtMs: 1,
      quoteAgeMs: 1,
      transportAgeMs: 1,
      stale: false,
      staleReason: null,
      lastError: null,
    };
    const html = renderOverview({
      system: maliciousSystem() as never,
      portfolio: { paper: realm, live: realm } as never,
      orders: { status: 'OK', provenance: PROV, orders: [], unresolvedCount: 0, totalCount: 0 } as never,
      market: market as never,
      health: null,
      reconciliation: emptyReconciliationState(),
      apiReachable: true,
    });
    expectSafe(html);
  });

  it('market: symbol and stale reason', () => {
    const market = {
      status: 'OK',
      provenance: PROV,
      symbol: MALICIOUS,
      last: '1.00000000',
      bid: '1.00000000',
      ask: '1.00000000',
      spread: '0.00000000',
      spreadPct: '0.00000000',
      quoteTimestampMs: 1,
      observedAtMs: 1,
      quoteAgeMs: 1,
      transportAgeMs: 1,
      stale: true,
      staleReason: MALICIOUS,
      lastError: MALICIOUS,
      reason: MALICIOUS,
    };
    expectSafe(renderMarket(market as never, MALICIOUS));
  });

  it('reconciliation: status, error, reasons, findings, balances', () => {
    const response = {
      status: 'RECONCILIATION_REQUIRED',
      provenance: PROV,
      requestedAtMs: 1,
      result: {
        status: 'RECONCILIATION_REQUIRED',
        reasons: [MALICIOUS],
        readFailures: [MALICIOUS],
        orderFindings: [
          {
            clientOrderId: MALICIOUS,
            exchangeOrderId: MALICIOUS,
            localStatus: MALICIOUS,
            exchangeStatus: MALICIOUS,
            disposition: MALICIOUS,
            executedQuantity: '0.00000000',
            provenExecutedQuantity: '0.00000000',
            completeness: MALICIOUS,
            reason: MALICIOUS,
          },
        ],
        executionFindings: [
          {
            executionId: MALICIOUS,
            orderId: MALICIOUS,
            symbol: MALICIOUS,
            side: 'BUY',
            quantity: '0.00000000',
            price: '0.00000000',
            fee: '0.00000000',
            feeProductId: null,
            feeDisposition: MALICIOUS,
            correlation: MALICIOUS,
            matchedClientOrderId: MALICIOUS,
            completeness: MALICIOUS,
            reason: MALICIOUS,
          },
        ],
        reservationFindings: [{ orderId: MALICIOUS, disposition: MALICIOUS, reason: MALICIOUS }],
        balanceFindings: [
          { currency: MALICIOUS, expected: '1.00000000', observed: '1.00000000', mismatch: true, reason: MALICIOUS },
        ],
        operatorFindings: [{ kind: MALICIOUS, detail: MALICIOUS }],
        commitCandidates: [],
        reservationReleases: [],
        canCommit: false,
      },
      error: MALICIOUS,
    };
    expectSafe(
      renderReconciliation({
        status: 'RECONCILIATION_REQUIRED',
        response: response as never,
        error: null,
        requestedAtMs: 1,
        pending: false,
      }),
    );
    expectSafe(
      renderReconciliation({
        status: 'ERROR',
        response: null,
        error: MALICIOUS,
        requestedAtMs: 1,
        pending: false,
      }),
    );
  });

  it('system: config, init reason, recovery reasons, health detail', () => {
    const health = {
      status: 'OK',
      provenance: PROV,
      authenticatedReadsEnabled: false,
      connected: true,
      latencyMs: 1,
      detail: MALICIOUS,
      checkedAtMs: 1,
      error: MALICIOUS,
    };
    expectSafe(renderSystem(maliciousSystem() as never, health as never, MALICIOUS, MALICIOUS));
  });
});
