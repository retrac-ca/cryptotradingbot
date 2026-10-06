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
import type {
  HealthSnapshot,
  MarketSnapshot,
  OrdersSnapshot,
  PortfolioRealmSnapshot,
  PortfolioSnapshot,
  ReconciliationResponse,
  SystemSnapshot,
} from '../../../web/src/types.js';

const PROV = { kind: 'managed_state' as const, asOfMs: 1000, fetchedAtMs: 1000, stale: false };

function realm(over: Partial<PortfolioRealmSnapshot> = {}): PortfolioRealmSnapshot {
  return {
    realm: 'paper',
    status: 'OK',
    provenance: PROV,
    cash: { CAD: '5000.00000000' },
    positions: [
      {
        symbol: 'BTC/CAD',
        quantity: '0.50000000',
        averageEntryPrice: '40000.00000000',
        costBasis: '0.00000000',
        realizedPnl: '0.00000000',
        feesPaid: '0.00000000',
        entryAnchorPrice: null,
        source: 'BOT',
        sourceQuantities: { BOT: '0.50000000', EXTERNAL_AUTHORIZED: '0.00000000' },
      },
    ],
    externalSnapshot: null,
    authorizedExternal: null,
    reserved: null,
    orderReservations: null,
    appliedExecutions: null,
    liveOrderAttestations: null,
    manualSettlements: null,
    peakEquity: '5200.00000000',
    realizedPnl: '100.00000000',
    dailyRealizedPnl: '10.00000000',
    dailyRealizedDayKey: '2026-01-01',
    totalFees: '1.00000000',
    ...over,
  };
}

function portfolio(): PortfolioSnapshot {
  return {
    paper: realm({ realm: 'paper' }),
    live: realm({
      realm: 'live',
      cash: { CAD: '1000.00000000' },
      positions: [
        {
          symbol: 'ETH/CAD',
          quantity: '0.10000000',
          averageEntryPrice: '3000.00000000',
          costBasis: '0.00000000',
          realizedPnl: '0.00000000',
          feesPaid: '0.00000000',
          entryAnchorPrice: null,
          source: 'BOT',
          sourceQuantities: { BOT: '0.06000000', EXTERNAL_AUTHORIZED: '0.04000000' },
        },
      ],
      externalSnapshot: { 'BTC/CAD': '0.20000000' },
      authorizedExternal: ['BTC/CAD'],
    }),
  };
}

function system(over: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    capturedAtMs: 1_000_000,
    config: {
      version: '1.2.1',
      tradingMode: 'paper',
      exchange: 'ndax',
      killSwitch: false,
      enableAuthenticatedReads: false,
      strategy: 'moving-average-crossover',
      timeframe: '5m',
      tradingPairs: ['BTC/CAD'],
      universeMarkets: ['BTC/CAD'],
    },
    init: { status: 'OK', paper: true, live: true },
    lock: { held: false },
    recovery: {
      status: 'READY',
      reasons: [],
      unresolvedOrders: [],
      unresolvedReservations: [],
      unresolvedIntents: [],
      crossFileIssues: [],
      requiresExchangeRead: false,
    },
    provenance: { kind: 'derived', asOfMs: 1_000_000, fetchedAtMs: 1_000_000, stale: false },
    ...over,
  };
}

function order(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientOrderId: 'live-BTCCAD-1',
    exchangeOrderId: '26177556994',
    symbol: 'BTC/CAD',
    side: 'SELL',
    type: 'limit',
    status: 'FILLED',
    quantity: '0.01000000',
    filledQuantity: '0.01000000',
    averagePrice: '100000.00000000',
    limitPrice: '100000.00000000',
    fills: [],
    fee: '0.00000000',
    feeCurrency: 'quote',
    reason: 'test',
    createdAtMs: 100,
    updatedAtMs: 200,
    resolution: null,
    ...over,
  };
}

function orders(over: Partial<OrdersSnapshot> = {}): OrdersSnapshot {
  return {
    status: 'OK',
    provenance: PROV,
    orders: [order() as never],
    unresolvedCount: 0,
    totalCount: 1,
    ...over,
  };
}

function unavailableMarket(): MarketSnapshot {
  return {
    status: 'UNAVAILABLE',
    reason: 'market data provider not running in this process',
    provenance: { kind: 'unavailable', asOfMs: null, fetchedAtMs: 1000, stale: true },
    symbol: 'BTC/CAD',
    last: null,
    bid: null,
    ask: null,
    spread: null,
    spreadPct: null,
    quoteTimestampMs: null,
    observedAtMs: null,
    quoteAgeMs: null,
    transportAgeMs: null,
    stale: true,
    staleReason: 'no provider',
    lastError: null,
  };
}

function freshMarket(): MarketSnapshot {
  return {
    status: 'OK',
    provenance: { kind: 'exchange_read', asOfMs: 999_500, fetchedAtMs: 1_000_000, stale: false },
    symbol: 'BTC/CAD',
    last: '100000.00000000',
    bid: '99990.00000000',
    ask: '100010.00000000',
    spread: '20.00000000',
    spreadPct: '0.02000000',
    quoteTimestampMs: 999_500,
    observedAtMs: 999_800,
    quoteAgeMs: 500,
    transportAgeMs: 200,
    stale: false,
    staleReason: null,
    lastError: null,
  };
}

function health(): HealthSnapshot {
  return {
    status: 'OK',
    provenance: { kind: 'exchange_read', asOfMs: 1, fetchedAtMs: 1, stale: false },
    authenticatedReadsEnabled: false,
    connected: true,
    latencyMs: 5,
    detail: 'ok',
    checkedAtMs: 1,
    error: null,
  };
}

describe('dashboard views — overview', () => {
  it('renders with mocked API responses', () => {
    const html = renderOverview({
      system: system(),
      portfolio: portfolio(),
      orders: orders(),
      market: freshMarket(),
      health: health(),
      reconciliation: emptyReconciliationState(),
      apiReachable: true,
    });
    expect(html).toContain('Overview');
    expect(html).toContain('1.2.1');
    expect(html).toContain('REACHABLE');
    expect(html).toContain('FRESH');
    expect(html).toContain('not requested');
  });

  it('keeps LIVE and PAPER separate and never combines them', () => {
    const html = renderOverview({
      system: system(),
      portfolio: portfolio(),
      orders: orders(),
      market: freshMarket(),
      health: health(),
      reconciliation: emptyReconciliationState(),
      apiReachable: true,
    });
    expect(html).toContain('LIVE portfolio');
    expect(html).toContain('PAPER portfolio');
    expect(html).toContain('CAD 1,000.00000000');
    expect(html).toContain('CAD 5,000.00000000');
    // No aggregated total (5000 + 1000 = 6000) is ever shown.
    expect(html).not.toContain('6,000');
    expect(html).not.toContain('6,000.00000000');
  });
});

describe('dashboard views — portfolio', () => {
  it('renders LIVE and PAPER as separate cards with exact strings', () => {
    const html = renderPortfolio(portfolio(), null);
    expect(html).toContain('LIVE PORTFOLIO');
    expect(html).toContain('PAPER PORTFOLIO');
    expect(html).toContain('1,000.00000000');
    expect(html).toContain('5,000.00000000');
  });

  it('keeps external/unmanaged and authorized external separate from managed', () => {
    const html = renderPortfolio(portfolio(), null);
    expect(html).toContain('EXTERNAL / UNMANAGED');
    expect(html).toContain('AUTHORIZED EXTERNAL');
    expect(html).toContain('0.20000000');
    expect(html).toContain('BTC/CAD');
    // external inventory is not merged into the managed position table totals.
    expect(html).not.toContain('0.70000000');
  });

  it('renders missing realm data as an em dash, never zero', () => {
    const missing = realm({
      realm: 'paper',
      status: 'MISSING',
      reason: 'no state file (realm not initialized)',
      cash: null,
      positions: null,
    });
    const html = renderPortfolio({ paper: missing, live: missing }, null);
    expect(html).toContain('MISSING');
    expect(html).toContain('—');
    expect(html).not.toContain('0.00000000');
  });

  it('marks a CORRUPT realm visibly and does not invent balances', () => {
    const corrupt = realm({
      realm: 'live',
      status: 'CORRUPT',
      reason: 'bad envelope',
      cash: null,
      positions: null,
    });
    const html = renderPortfolio({ paper: corrupt, live: corrupt }, null);
    expect(html).toContain('CORRUPT');
    expect(html).toContain('bad envelope');
    expect(html).not.toContain('0.00000000');
  });
});

describe('dashboard views — market', () => {
  it('shows FRESH data as current', () => {
    const html = renderMarket(freshMarket(), null);
    expect(html).toContain('FRESH');
    expect(html).toContain('100,000.00000000');
    expect(html).not.toContain('UNAVAILABLE');
  });

  it('visibly marks stale data as STALE', () => {
    const stale = { ...freshMarket(), stale: true, staleReason: 'QUOTE_STALE' };
    const html = renderMarket(stale, null);
    expect(html).toContain('STALE');
    expect(html).toContain('QUOTE_STALE');
    expect(html).toContain('must not be treated as current');
  });

  it('shows UNAVAILABLE instead of a zero price when data is missing', () => {
    const html = renderMarket(unavailableMarket(), null);
    expect(html).toContain('UNAVAILABLE');
    expect(html).not.toContain('0.00000000');
    expect(html).not.toContain('$0');
  });

  it('reports a fetch failure without crashing', () => {
    const html = renderMarket(null, 'request failed');
    expect(html).toContain('UNAVAILABLE');
    expect(html).toContain('request failed');
  });
});

describe('dashboard views — orders', () => {
  it('displays the actual lifecycle status values from the API', () => {
    const snapshot = orders({
      orders: [
        order({ clientOrderId: 'a', status: 'FILLED' }),
        order({ clientOrderId: 'b', status: 'UNKNOWN' }),
        order({ clientOrderId: 'c', status: 'OPEN' }),
        order({ clientOrderId: 'd', status: 'CANCELLED' }),
      ] as never,
      totalCount: 4,
    });
    const html = renderOrders(snapshot, null);
    expect(html).toContain('FILLED');
    expect(html).toContain('UNKNOWN');
    expect(html).toContain('OPEN');
    expect(html).toContain('CANCELLED');
  });

  it('surfaces a corrupt ledger visibly', () => {
    const html = renderOrders(orders({ status: 'CORRUPT', reason: 'bad ledger', orders: null }), null);
    expect(html).toContain('CORRUPT');
    expect(html).toContain('bad ledger');
  });
});

describe('dashboard views — reconciliation', () => {
  it('preserves HALTED instead of turning it into success', () => {
    const html = renderReconciliation({
      status: 'HALTED',
      response: null,
      error: null,
      requestedAtMs: 123,
      pending: false,
    });
    expect(html).toContain('HALTED');
    expect(html).toContain('not commit accounting');
  });

  it('does not turn an ERROR into a clean reconciliation', () => {
    const html = renderReconciliation({
      status: 'ERROR',
      response: null,
      error: 'reconciliation read failed',
      requestedAtMs: 123,
      pending: false,
    });
    expect(html).toContain('ERROR');
    expect(html).toContain('NOT a clean reconciliation');
  });

  it('shows UNAVAILABLE honestly', () => {
    const html = renderReconciliation({
      status: 'UNAVAILABLE',
      response: null,
      error: null,
      requestedAtMs: 5,
      pending: false,
    });
    expect(html).toContain('UNAVAILABLE');
  });

  it('renders balance findings from an explicit result', () => {
    const response: ReconciliationResponse = {
      status: 'RECONCILIATION_REQUIRED',
      provenance: { kind: 'derived', asOfMs: 10, fetchedAtMs: 10, stale: false },
      requestedAtMs: 10,
      result: {
        status: 'RECONCILIATION_REQUIRED',
        reasons: ['balance mismatch'],
        readFailures: [],
        orderFindings: [],
        executionFindings: [],
        reservationFindings: [],
        balanceFindings: [
          { currency: 'CAD', expected: '1000.00000000', observed: '999.00000000', mismatch: true, reason: 'diff' },
        ],
        operatorFindings: [],
        commitCandidates: [],
        reservationReleases: [],
        canCommit: false,
      },
      error: null,
    };
    const html = renderReconciliation({
      status: 'RECONCILIATION_REQUIRED',
      response,
      error: null,
      requestedAtMs: 10,
      pending: false,
    });
    expect(html).toContain('MISMATCH');
    expect(html).toContain('1,000.00000000');
    expect(html).toContain('999.00000000');
  });

  it('disables the request control while pending', () => {
    const html = renderReconciliation({
      ...emptyReconciliationState(),
      pending: true,
    });
    expect(html).toContain('disabled');
    expect(html).toContain('Requesting…');
  });
});

describe('dashboard views — system', () => {
  it('shows non-secret operational state and NDAX health', () => {
    const html = renderSystem(system(), health(), null, null);
    expect(html).toContain('1.2.1');
    expect(html).toContain('Mutation lock');
    expect(html).toContain('NDAX health');
    expect(html).toContain('RELEASED');
  });

  it('degrades gracefully when status is unavailable', () => {
    const html = renderSystem(null, null, 'request failed', 'request failed');
    expect(html).toContain('UNAVAILABLE');
    expect(html).toContain('request failed');
  });
});

describe('dashboard views — no operator controls', () => {
  it('contains exactly one button (the explicit reconciliation request) and no trading actions', () => {
    const combined = [
      renderOverview({
        system: system(),
        portfolio: portfolio(),
        orders: orders(),
        market: freshMarket(),
        health: health(),
        reconciliation: emptyReconciliationState(),
        apiReachable: true,
      }),
      renderMarket(unavailableMarket(), null),
      renderPortfolio(portfolio(), null),
      renderOrders(orders(), null),
      renderReconciliation(emptyReconciliationState()),
      renderSystem(system(), health(), null, null),
    ].join('\n');

    const buttonMatches = combined.match(/<button/g) ?? [];
    expect(buttonMatches.length).toBe(1);
    expect(combined).toContain('data-action="reconcile-request"');

    // No other interactive controls and no forms/actions exist.
    const actions = [...combined.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
    expect(actions).toEqual(['reconcile-request']);
    expect(combined).not.toMatch(/<form/i);
    expect(combined).not.toMatch(/<input/i);
    expect(combined).not.toMatch(/data-action="(buy|sell|cancel|resolve|attest|retry)"/i);
  });
});
