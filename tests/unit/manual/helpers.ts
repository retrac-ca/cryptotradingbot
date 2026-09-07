/**
 * Shared test helpers for the Gate 9 manual-execution bridge suite.
 *
 * These construct the REAL `ManualTradeBridge` + `RiskManager` + `Portfolio` +
 * a file-backed `ManualIntentStore`, with a `FakeExchange` used ONLY as the
 * read-only authoritative adapter (`getOrderStatus`). No test path ever calls
 * `placeOrder`/`cancelOrder` or moves real funds.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { ManualIntentStore, ManualTradeBridge } from '../../../src/manual/index.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { MarketInfo, Balance, SymbolStr } from '../../../src/types.js';
import type { Order } from '../../../src/order.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';

export const BTC: SymbolStr = 'BTC/CAD';
export const PRICE = Money.fromString('40000.00');
export const NOW = 1_000_000_000;

export const marketInfo: MarketInfo = {
  symbol: BTC,
  exchangeId: '1',
  priceTick: Money.fromString('0.01'),
  basePrecision: 8,
  quotePrecision: 2,
  quantityTick: Money.fromString('0.00000001'),
  minOrderBase: Money.fromString('0.0001'),
  minOrderQuote: null,
  supportsMarketOrders: true,
  feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
};

export const riskConfig: RiskConfig = {
  maxTradeAmount: Money.zero(),
  maxPositionSizeFraction: 0.1,
  maxPortfolioExposureFraction: 0.5,
  maxDailyLossFraction: 0.05,
  maxDrawdownFraction: 0.1,
  cooldownAfterLossMs: 3_600_000,
  maxOpenPositions: 5,
  marketDataMaxAgeMs: 60_000,
  marketDataTransportMaxAgeMs: 60_000,
  maxClockSkewMs: 120_000,
};

export function risk(): RiskManager {
  return new RiskManager(riskConfig);
}

export function makeContext(signalType: 'BUY' | 'SELL' | 'HOLD', over: Partial<RiskContext> = {}): RiskContext {
  const qb: Balance = {
    currency: 'CAD',
    total: Money.fromString('100000.00'),
    available: Money.fromString('100000.00'),
    held: Money.zero(),
  };
  return {
    symbol: BTC,
    signal: signal(BTC, signalType, {}, NOW),
    nowMs: NOW,
    marketDataTimestampMs: NOW,
    marketDataObservedAtMs: NOW,
    price: PRICE,
    marketInfo,
    quoteBalance: qb,
    deployableQuote: Money.fromString('100000.00'),
    portfolioValue: Money.fromString('50000.00'),
    peakPortfolioValue: Money.fromString('50000.00'),
    portfolioExposure: Money.zero(),
    currentPosition: Money.zero(),
    externalPosition: Money.zero(),
    openManagedPositionCount: 0,
    realizedPnlToday: Money.fromString('0.00'),
    unrealizedPnlToday: Money.fromString('0.00'),
    ...over,
  };
}

export function makePortfolio(cash: string, holdings?: { external?: Map<string, Money> }): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString(cash)]]), { externalSnapshot: holdings?.external });
}

export class TestHarness {
  intentStore: ManualIntentStore;
  bridge: ManualTradeBridge;
  adapter: FakeExchange;
  currentPortfolio: Portfolio;
  private readonly dir: string;

  constructor(opts: { portfolio?: Portfolio; adapter?: FakeExchange; intentFilePath: string }) {
    // A unique subdirectory per harness isolates the state-directory mutation
    // lock (the lock is per-directory) and prevents cross-test contention.
    const uniqueDir = mkdtempSync(join(tmpdir(), 'retrac-manual-'));
    this.dir = join(uniqueDir, 'intents.json');
    rmSync(this.dir, { force: true });
    rmSync(`${this.dir}.tmp`, { force: true });
    this.currentPortfolio = opts.portfolio ?? makePortfolio('100000');
    this.adapter = opts.adapter ?? new FakeExchange();
    this.intentStore = new ManualIntentStore(this.dir);
    this.bridge = new ManualTradeBridge({
      intentStore: this.intentStore,
      getPortfolio: () => this.currentPortfolio,
      savePortfolio: (p) => {
        this.currentPortfolio = p;
      },
      riskManager: risk(),
      adapter: this.adapter,
      nowMs: () => NOW,
      operator: 'test-operator',
    });
  }

  get port(): Portfolio {
    return this.currentPortfolio;
  }

  /** Seed the adapter's order status read for a given exchangeOrderId. */
  seedOrder(...orders: Order[]): void {
    this.adapter.seedOrders(orders);
  }

  cleanup(): void {
    rmSync(this.dir, { force: true });
    rmSync(`${this.dir}.tmp`, { force: true });
    rmSync(join(this.dir, '..'), { recursive: true, force: true });
  }
}

/** Build a canonical Order reflecting a created/terminal exchange order. */
export function exchangeOrder(partial: Partial<Order> & { exchangeOrderId: string }): Order {
  return {
    clientOrderId: '',
    symbol: BTC,
    side: 'BUY',
    type: 'market',
    status: 'FILLED',
    quantity: Money.fromString('0.50'),
    filledQuantity: Money.fromString('0.50'),
    averagePrice: PRICE,
    price: null,
    fills: [],
    fee: Money.fromString('40.00'),
    feeCurrency: 'quote',
    reason: '',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...partial,
  };
}
