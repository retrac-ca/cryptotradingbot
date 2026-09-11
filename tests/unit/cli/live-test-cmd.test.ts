import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { PaperStateStore } from '../../../src/persistence/PaperStateStore.js';
import { ManagedStateStore } from '../../../src/persistence/ManagedStateStore.js';
import { ManualIntentStore } from '../../../src/manual/ManualIntentStore.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { buildRiskManager } from '../../../src/risk/index.js';
import type { BotConfig } from '../../../src/config/schema.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import {
  executeLiveTest,
  fetchLiveSnapshot,
  loadLiveManagedPortfolio,
  LIVE_TEST_DEFAULT_TARGET_CAD,
  LIVE_TEST_MAX_TARGET_CAD,
  parseLiveTestArgs,
} from '../../../src/cli/live-test-cmd.js';
import { evaluateFreshness } from '../../../src/marketdata/index.js';
import type { AccountTrade, MarketInfo, Ticker } from '../../../src/types.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('livetest', 'ledger.json');
const STATE_DIR = dirname(LEDGER);
const LIVE_FILE = join(STATE_DIR, 'live.json');
const INTENTS_FILE = join(STATE_DIR, 'intents.json');
const SYMBOL = 'BTC/CAD';
const T0 = Date.now();

const market: MarketInfo = {
  symbol: SYMBOL,
  exchangeId: '1',
  priceTick: Money.fromString('0.01'),
  basePrecision: 8,
  quotePrecision: 2,
  quantityTick: Money.fromString('0.00000001'),
  minOrderBase: Money.fromString('0'),
  minOrderQuote: Money.fromString('1'),
  supportsMarketOrders: true,
  feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
};

function cfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    tradingMode: 'live',
    realFundsAtRisk: true,
    exchange: 'ndax',
    ndaxApiKey: '',
    ndaxApiSecret: '',
    ndaxUserId: '',
    ndaxUserName: '',
    enableAuthenticatedReads: true,
    tradingPairs: [SYMBOL],
    strategy: 'moving-average-crossover',
    timeframe: '5m',
    maFastPeriod: 5,
    maSlowPeriod: 10,
    maxPositionSizeFraction: 0.1,
    maxTradeAmount: 0,
    stopLossFraction: 0.05,
    takeProfitFraction: 0.1,
    maxDailyLossFraction: 0.05,
    maxOpenPositions: 1,
    cooldownAfterLossSeconds: 3600,
    maxPortfolioExposureFraction: 0.5,
    maxDrawdownFraction: 0.1,
    marketDataMaxAgeMs: 60000,
    marketDataTransportMaxAgeMs: 60000,
    maxClockSkewMs: 120000,
    paperStartingBalance: 10000,
    liveMaxBaseQuantity: 0.01,
    liveMaxQuoteNotional: 100,
    logLevel: 'info',
    reconcileIntervalSeconds: 60,
    killSwitch: false,
    orderLedgerFile: LEDGER,
    stateDir: STATE_DIR,
    liveManagedStateFile: LIVE_FILE,
    manualIntentFile: INTENTS_FILE,
    paperStateFile: join(STATE_DIR, 'paper.json'),
    ...over,
  } as BotConfig;
}

function ticker(over: Partial<Ticker> = {}): Ticker {
  return {
    symbol: SYMBOL,
    bid: Money.fromString('40000'),
    ask: Money.fromString('40001'),
    last: Money.fromString('40000'),
    open: null,
    high: null,
    low: null,
    baseVolume: null,
    quoteVolume: null,
    timestampMs: T0,
    ...over,
  };
}

interface Deps {
  cfg: BotConfig;
  adapter: FakeExchange;
  store: OrderStore;
  live: ManagedStateStore;
  manualIntents: ManualIntentStore;
  reconcile: ReconcileService;
  riskManager: ReturnType<typeof buildRiskManager>;
  portfolio: Portfolio;
  confirm?: (message: string) => Promise<boolean>;
  nowMs?: () => number;
}

function buildDeps(over: { cfg?: Partial<BotConfig>; adapter?: (e: FakeExchange) => void; confirm?: (m: string) => Promise<boolean>; portfolio?: Portfolio; nowMs?: () => number } = {}): Deps {
  rmSync(LEDGER, { force: true });
  rmSync(LIVE_FILE, { force: true });
  rmSync(INTENTS_FILE, { force: true });
  const c = cfg(over.cfg);
  const adapter = new FakeExchange({
    balances: { BTC: '0.25', CAD: '100000' },
    markets: { [SYMBOL]: market },
    tickers: { [SYMBOL]: ticker() },
  });
  over.adapter?.(adapter);
  const store = new OrderStore(LEDGER);
  const reconcile = new ReconcileService(adapter, store);
  const riskManager = buildRiskManager(c);
  // Default managed portfolio: the bot EXCHANGE-CONFIRMED managing 0.25 BTC
  // (as if it acquired it), so the pre-existing exchange balance is all managed.
  const portfolio =
    over.portfolio ??
    Portfolio.empty(new Map([['CAD', Money.fromString('100000')]]))
      .applyFill(SYMBOL, 'BUY', Money.fromString('0.25'), ticker().bid!, Money.fromString('5'));
  // V1 reconciliation reads the durable live-managed store, so keep it in sync
  // with the in-memory portfolio the risk/engine layers use.
  const live = new ManagedStateStore(LIVE_FILE);
  live.save(portfolio.stateModel);
  const manualIntents = new ManualIntentStore(INTENTS_FILE);
  return {
    cfg: c,
    adapter,
    store,
    live,
    manualIntents,
    reconcile,
    riskManager,
    portfolio,
    confirm: over.confirm ?? (async () => true),
    nowMs: over.nowMs ?? (() => T0),
  };
}

const opts = { confirmLive: true, targetCad: 12 };

function harness(deps: Deps, o: typeof opts = opts) {
  return executeLiveTest(deps, o);
}

// --- parseLiveTestArgs ---

describe('parseLiveTestArgs', () => {
  it('defaults to a small bounded target and no confirm', () => {
    const r = parseLiveTestArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opts.targetCad).toBe(LIVE_TEST_DEFAULT_TARGET_CAD);
      expect(r.opts.confirmLive).toBe(false);
    }
  });

  it('parses sell + --target-cad + --confirm-live', () => {
    const r = parseLiveTestArgs(['sell', '--target-cad', '20', '--confirm-live']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opts.targetCad).toBe(20);
      expect(r.opts.confirmLive).toBe(true);
    }
  });

  it('rejects unknown / quantity-injection arguments', () => {
    for (const args of [['--quantity', '1'], ['-q', '1'], ['buy'], ['--bogus']]) {
      const r = parseLiveTestArgs(args);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects a missing value, non-numeric, negative, or over-limit target', () => {
    expect(parseLiveTestArgs(['--target-cad']).ok).toBe(false);
    expect(parseLiveTestArgs(['--target-cad', 'abc']).ok).toBe(false);
    expect(parseLiveTestArgs(['--target-cad', '-5']).ok).toBe(false);
    expect(parseLiveTestArgs(['--target-cad', String(LIVE_TEST_MAX_TARGET_CAD + 1)]).ok).toBe(false);
  });
});

// --- executeLiveTest: gates fail closed before any exchange contact ---

describe('executeLiveTest — gates (fail closed, no exchange contact)', () => {
  it('refuses in paper mode', async () => {
    const deps = buildDeps({ cfg: { tradingMode: 'paper' } });
    expect(await harness(deps)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('refuses when REAL_FUNDS_AT_RISK is not acknowledged', async () => {
    const deps = buildDeps({ cfg: { realFundsAtRisk: false } });
    expect(await harness(deps)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('refuses when the kill switch is active', async () => {
    const deps = buildDeps({ cfg: { killSwitch: true } });
    expect(await harness(deps)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('refuses without --confirm-live', async () => {
    const deps = buildDeps();
    expect(await harness(deps, { confirmLive: false, targetCad: 12 })).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('refuses when authenticated reads are disabled', async () => {
    const deps = buildDeps({ cfg: { enableAuthenticatedReads: false } });
    expect(await harness(deps)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('proceeds via the controlled-test authorization even when the adapter reports supportsOrderPlacement=false', async () => {
    const deps = buildDeps({
      adapter: (e) => {
        (e.capabilities as { supportsOrderPlacement: boolean }).supportsOrderPlacement = false;
      },
    });
    // The controlled-test path uses an explicit, narrowly-scoped authorization
    // (SELL + LIMIT) instead of the general `supportsOrderPlacement` capability.
    const led = await executeLiveTest(deps, { confirmLive: true, targetCad: 12 });
    expect(led).toBe(0);
    expect(deps.adapter.submittedOrders).toHaveLength(1);
    expect(deps.adapter.submittedOrders[0]!.side).toBe('SELL');
    expect(deps.adapter.submittedOrders[0]!.type).toBe('limit');
  });

  it('refuses when more than one trading pair is configured', async () => {
    const deps = buildDeps({ cfg: { tradingPairs: ['BTC/CAD', 'ETH/CAD'] } });
    expect(await harness(deps)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('refuses when reconciliation is not safe to trade', async () => {
    const deps = buildDeps();
    // Seed the ledger with an order the exchange does not know about.
    const now = Date.now();
    deps.store.save({
      clientOrderId: 'orphan',
      exchangeOrderId: null,
      symbol: SYMBOL,
      side: 'BUY',
      type: 'market',
      status: 'SUBMITTED',
      quantity: Money.fromString('0.1'),
      filledQuantity: Money.zero(),
      averagePrice: null,
      price: null,
      fills: [],
      fee: Money.zero(),
      feeCurrency: 'quote',
      reason: 'seed',
      createdAtMs: now,
      updatedAtMs: now,
    });
    expect(await harness(deps)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });
});

// --- executeLiveTest: V1 action-aware pre-trade reconciliation (P2-1) ---

describe('executeLiveTest — V1 action-aware pre-trade reconciliation (P2-1)', () => {
  it('a bounded SELL passes despite the known external/unmanaged CAD mismatch', async () => {
    // Managed: 0.00023352 BTC + 11.97501697 CAD. Exchange: same BTC, but
    // 37.99775272 CAD (26.02273575 is external/unmanaged). A SELL does not
    // consume CAD, so the quote mismatch must not block.
    const managed = Portfolio.empty(new Map([['CAD', Money.fromString('11.97501697')]]))
      .withExternalSnapshot(new Map([[SYMBOL, Money.fromString('0.00023352')]]))
      .authorizeExternal(SYMBOL);
    const deps = buildDeps({
      portfolio: managed,
      adapter: (e) => {
        e.setBalance('BTC', '0.00023352');
        e.setBalance('CAD', '37.99775272');
      },
    });
    const led = await executeLiveTest(deps, opts);
    expect(led).toBe(0);
    expect(deps.adapter.submittedOrders).toHaveLength(1);
    expect(deps.adapter.submittedOrders[0]!.side).toBe('SELL');
  });

  it('blocks on a V1 read failure (and places nothing)', async () => {
    const deps = buildDeps({ adapter: (e) => e.setFailures({ getOpenOrders: { kind: 'network' } }) });
    const led = await harness(deps);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('blocks on an uncorrelated execution (V1-only; the legacy gate did not catch this)', async () => {
    const trade: AccountTrade = {
      executionId: 'e-uncorrelated',
      tradeId: 't1',
      orderId: '999999',
      clientOrderId: '0',
      symbol: SYMBOL,
      instrumentId: '1',
      accountId: '1',
      subAccountId: '0',
      side: 'BUY',
      quantity: Money.fromString('0.1'),
      remainingQuantity: Money.zero(),
      price: Money.fromString('40000'),
      value: Money.fromString('4000'),
      tradeTimeMs: T0,
      fee: Money.zero(),
      feeProductId: null,
      orderOriginator: null,
    };
    const deps = buildDeps({ adapter: (e) => e.seedAccountTrades([trade]) });
    const led = await harness(deps);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('blocks on a FILLED order whose execution evidence is not proven/attested', async () => {
    const now = Date.now();
    const deps = buildDeps();
    const filled = {
      clientOrderId: 'live-BTCCAD-filled',
      exchangeOrderId: '999',
      symbol: SYMBOL,
      side: 'SELL' as const,
      type: 'limit' as const,
      status: 'FILLED' as const,
      quantity: Money.fromString('0.0003'),
      filledQuantity: Money.fromString('0.0003'),
      averagePrice: Money.fromString('40000'),
      price: Money.fromString('40000'),
      fills: [],
      fee: Money.zero(),
      feeCurrency: 'unknown' as const,
      reason: 'seed',
      createdAtMs: now,
      updatedAtMs: now,
    };
    deps.store.save(filled);
    // Exchange reports FILLED but no executions are observable, so completeness
    // stays UNKNOWN -> V1 disposition OPERATOR_REQUIRED -> block.
    deps.adapter.seedOrders([{ ...filled, clientOrderId: '', reason: '' }]);
    const led = await harness(deps);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });
});

// --- executeLiveTest: risk/decision path ---

describe('executeLiveTest — risk + confirmation', () => {
  it('places exactly ONE risk-sized SELL on the exchange when confirmed', async () => {
    const deps = buildDeps();
    const led = await executeLiveTest(deps, opts);
    expect(led).toBe(0);
    expect(deps.adapter.submittedOrders).toHaveLength(1);
    expect(deps.adapter.submittedOrders[0]!.side).toBe('SELL');
    // 12 CAD / 40000 = 0.0003 BTC, floored to the 1e-8 tick.
    expect(deps.adapter.submittedOrders[0]!.quantity.toFixed(8)).toBe('0.00030000');
  });

  it('aborts (no order) when confirmation is declined', async () => {
    const deps = buildDeps({ confirm: async () => false });
    const led = await executeLiveTest(deps, opts);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('refuses before contacting the exchange when risk rejects (kill switch)', async () => {
    const deps = buildDeps();
    deps.riskManager.setKillSwitch(true);
    const led = await harness(deps);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('refuses on stale market data (risk fails closed, no exchange contact)', async () => {
    const deps = buildDeps({
      adapter: (e) => e.setTicker(SYMBOL, { bid: Money.fromString('40000'), last: Money.fromString('40000'), timestampMs: T0 - 3600_000 }),
    });
    const led = await harness(deps);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('does not auto-retry an ambiguous submission (timeout => UNKNOWN => exit 1)', async () => {
    const deps = buildDeps();
    deps.adapter.setFailures({ placeOrder: { kind: 'timeout' } });
    const led = await harness(deps);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('confirms the lifecycle from authoritative state after an ack and exits 0', async () => {
    const deps = buildDeps();
    const led = await executeLiveTest(deps, opts);
    expect(led).toBe(0);
    // Filled behavior means the exchange back-reports a fill; the engine records
    // the ack as SUBMITTED but refresh confirms the authoritative lifecycle.
    expect(deps.adapter.getOrders()).toHaveLength(1);
  });

  it('refuses to SELL external (non-bot-managed) inventory even though the exchange holds the asset', async () => {
    // Exchange truth: 0.25 BTC. Bot-managed: 0. A SELL must be rejected — the
    // bot never sells what it does not manage.
    const deps = buildDeps({
      portfolio: Portfolio.empty(new Map([['CAD', Money.fromString('100000')]]))
        .withExternalSnapshot(new Map([[SYMBOL, Money.fromString('0.25')]])),
    });
    const led = await harness(deps);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('only sells up to the managed quantity when external + managed coexist', async () => {
    // Managed 0.0025 BTC, external 0.2475 BTC on the exchange. A SELL target far
    // larger than managed must still be capped to the managed quantity.
    const managed = Portfolio.empty(new Map([['CAD', Money.fromString('100000')]]))
      .applyFill(SYMBOL, 'BUY', Money.fromString('0.0025'), ticker().bid!, Money.fromString('5'))
      .withExternalSnapshot(new Map([[SYMBOL, Money.fromString('0.2475')]]));
    const deps = buildDeps({ portfolio: managed });
    const led = await executeLiveTest(deps, { ...opts, targetCad: 1000 });
    expect(led).toBe(0);
    expect(deps.adapter.submittedOrders).toHaveLength(1);
    // 1000/40000 = 0.025 but capped to managed 0.0025.
    expect(deps.adapter.submittedOrders[0]!.quantity.toFixed(8)).toBe('0.00250000');
  });

  it('F-1 test 6/7: an empty LIVE portfolio cannot sell even though the exchange holds BTC', async () => {
    // FakeExchange truth: 0.25 BTC on the account. LIVE managed portfolio: empty
    // (no managed positions, no paper fallback). A SELL must be rejected — the
    // RiskContext receives currentPosition = 0, not 0.25, so the user asset is
    // never sold based on paper/exchange state.
    const emptyLive = Portfolio.empty(new Map([['CAD', Money.fromString('100000')]]))
      .withExternalSnapshot(new Map([[SYMBOL, Money.fromString('0.25')]]));
    const deps = buildDeps({ portfolio: emptyLive });
    const led = await executeLiveTest(deps, opts);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
    // Confirm the risk layer saw zero managed position (SELL_EXCEEDS_MANAGED_POSITION).
    // (The decision doesn't surface here; the key proof is: no order, exit 1.)
  });

  it('F-1 test 5: loadLiveManagedPortfolio does NOT fall back to paper state', () => {
    const paperFile = statePath('livetest-f1', 'paper.json');
    const liveFile = statePath('livetest-f1', 'live.json');
    rmSync(paperFile, { force: true });
    rmSync(liveFile, { force: true });
    // Paper holds 0.25 BTC; live managed state is absent.
    const paper = new PaperStateStore(paperFile);
    paper.save(
      Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]))
        .applyFill(SYMBOL, 'BUY', Money.fromString('0.25'), Money.fromString('40000'), Money.zero())
        .stateModel,
      ['p1'],
    );
    const live = loadLiveManagedPortfolio({ liveManagedStateFile: liveFile, paperStateFile: paperFile } as BotConfig);
    expect(live.position(SYMBOL)).toBeNull();
    expect(live.managedOpenCount()).toBe(0);
    rmSync(paperFile, { force: true });
    rmSync(liveFile, { force: true });
  });
});


// --- F-4: execution-time freshness (TOCTOU) ---

describe('live-test — F-4 execution-time freshness', () => {
  it('rejects when the operator waits beyond the freshness limit (data stale at execution)', async () => {
    // The initial snapshot is fresh (T0). The operator then waits > marketDataMaxAgeMs.
    // The FRESH pre-submit fetch reads the still-stale ticker timestamp at a later
    // now, so freshness fails and NO order is placed. Under the old code the
    // initial nowMs would have been reused, incorrectly approving the order.
    let clock = T0;
    const deps = buildDeps({
      nowMs: () => clock,
      confirm: async () => {
        clock += 5 * 60_000; // operator waits 5 minutes beyond the 60s limit
        return true;
      },
    });
    const led = await executeLiveTest(deps, opts);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('uses fresh pre-submit data for the final decision (not the original snapshot)', async () => {
    // The market updates to a fresh timestamp right as the operator confirms. The
    // fresh pre-submit fetch sees FRESH data and the order proceeds.
    let clock = T0;
    let adapt: FakeExchange;
    const deps = buildDeps({
      nowMs: () => clock,
      confirm: async () => {
        clock += 2000;
        adapt.setTicker(SYMBOL, { bid: Money.fromString('40000'), ask: Money.fromString('40001'), last: Money.fromString('40000'), timestampMs: clock });
        return true;
      },
    });
    adapt = deps.adapter;
    const led = await executeLiveTest(deps, opts);
    expect(led).toBe(0);
    expect(deps.adapter.submittedOrders).toHaveLength(1);
  });

  it('fails closed when the pre-submit exchange timestamp is missing (never substitutes local time)', async () => {
    let clock = T0;
    let adapt: FakeExchange;
    const deps = buildDeps({
      nowMs: () => clock,
      confirm: async () => {
        // NDAX provides no authoritative timestamp at pre-submit time.
        adapt.setTicker(SYMBOL, { ...ticker(), timestampMs: null as unknown as number });
        return true;
      },
    });
    adapt = deps.adapter;
    const led = await executeLiveTest(deps, opts);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('fails closed when the fresh pre-submit fetch fails (no market data)', async () => {
    const deps = buildDeps({
      confirm: async () => {
        deps.adapter.setFailures({ getTicker: { kind: 'network' } });
        return true;
      },
    });
    const led = await executeLiveTest(deps, opts);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });
});

// NDAX quote-freshness basis (F-3/F-8): the L2 order-book `ActionDateTime`
// is the authoritative quote freshness timestamp. The L1 `TimeStamp` is a
// last-trade/session timestamp that can lag the quote, so it must NOT be used
// as the primary freshness basis. These tests exercise `fetchLiveSnapshot`.
describe('live snapshot — NDAX quote-freshness basis (L2 ActionDateTime)', () => {
  const T0 = Date.now();
  const policy = { maxQuoteAgeMs: 60_000, maxTransportAgeMs: 60_000, maxAcceptableFutureSkewMs: 120_000 };

  function exchangeWith(opts: { l1Ts: number; bookTs: number | null; bookPresent: boolean }) {
    const ex = new FakeExchange({
      balances: { BTC: '0.25', CAD: '100000' },
      markets: { [SYMBOL]: market },
      tickers: { [SYMBOL]: ticker({ timestampMs: opts.l1Ts }) },
    });
    if (opts.bookPresent) {
      ex.setOrderBook(SYMBOL, {
        symbol: SYMBOL,
        timestampMs: opts.bookTs ?? 0,
        quoteTimestampMs: opts.bookTs ?? undefined,
        bids: [],
        asks: [],
      });
    }
    return ex;
  }

  it('a fresh L2 ActionDateTime prevents a false STALE_MARKET_DATA rejection even when the L1 TimeStamp is old', async () => {
    const oldL1 = T0 - 130_000; // beyond the 60s quote-age limit
    const freshL2 = T0 - 2_000; // within the 60s quote-age limit
    const snap = await fetchLiveSnapshot(
      { adapter: exchangeWith({ l1Ts: oldL1, bookTs: freshL2, bookPresent: true }), nowMs: () => T0, policy },
      SYMBOL,
    );
    // The L2 book timestamp is the freshness basis, so the stale L1 is ignored.
    expect(snap.quoteTs).toBe(freshL2);
    expect(snap.freshness).toEqual({ fresh: true });
  });

  it('a stale L2 timestamp still causes STALE_MARKET_DATA', async () => {
    const staleL2 = T0 - 70_000; // beyond the 60s quote-age limit
    const snap = await fetchLiveSnapshot(
      { adapter: exchangeWith({ l1Ts: T0 - 2_000, bookTs: staleL2, bookPresent: true }), nowMs: () => T0, policy },
      SYMBOL,
    );
    expect(snap.quoteTs).toBe(staleL2);
    expect(snap.freshness.fresh).toBe(false);
    if (!snap.freshness.fresh) expect(snap.freshness.reason).toBe('QUOTE_STALE');
  });

  it('a missing L2 timestamp does NOT fabricate local time (falls back to the L1 TimeStamp)', async () => {
    const l1 = T0 - 2_000;
    // No order book => getOrderBook throws => bookQuoteTs null => use L1.
    const snap = await fetchLiveSnapshot(
      { adapter: exchangeWith({ l1Ts: l1, bookTs: null, bookPresent: false }), nowMs: () => T0, policy },
      SYMBOL,
    );
    expect(snap.quoteTs).toBe(l1);
    expect(snap.quoteTs).not.toBe(T0);
    expect(snap.freshness.fresh).toBe(true);
  });

  it('a present book with no valid quoteTimestampMs also falls back to the L1 TimeStamp', async () => {
    const l1 = T0 - 2_000;
    // Book present but quoteTimestampMs undefined => bookQuoteTs null.
    const snap = await fetchLiveSnapshot(
      { adapter: exchangeWith({ l1Ts: l1, bookTs: 0, bookPresent: true }), nowMs: () => T0, policy },
      SYMBOL,
    );
    expect(snap.quoteTs).toBe(l1);
    expect(snap.freshness.fresh).toBe(true);
  });

  it('missing L1 and L2 fails closed as QUOTE_MISSING (no fabricated exchange time)', async () => {
    // l1Ts = 0 is not a valid epoch-ms => l1 null; no book => book null.
    const snap = await fetchLiveSnapshot(
      { adapter: exchangeWith({ l1Ts: 0, bookTs: null, bookPresent: false }), nowMs: () => T0, policy },
      SYMBOL,
    );
    expect(snap.quoteTs).toBeNull();
    expect(snap.freshness.fresh).toBe(false);
    if (!snap.freshness.fresh) expect(snap.freshness.reason).toBe('QUOTE_MISSING');
  });

  it('the future-skew guard still fires for an L2 timestamp ahead of the clock', async () => {
    const ahead = T0 + 130_000; // beyond the 120s maxAcceptableFutureSkewMs
    const snap = await fetchLiveSnapshot(
      { adapter: exchangeWith({ l1Ts: T0 - 2_000, bookTs: ahead, bookPresent: true }), nowMs: () => T0, policy },
      SYMBOL,
    );
    expect(snap.freshness.fresh).toBe(false);
    if (!snap.freshness.fresh) expect(snap.freshness.reason).toBe('QUOTE_AHEAD_OF_CLOCK');
  });

  it('the transport-age check remains enforced', () => {
    const check = evaluateFreshness({
      nowMs: T0,
      quoteTimestampMs: T0 - 1_000, // fresh quote
      observedAtMs: T0 - 70_000, // old local observation
      policy,
    });
    expect(check.fresh).toBe(false);
    if (!check.fresh) expect(check.reason).toBe('TRANSPORT_STALE');
  });

  it('the 60-second quote-age threshold is unchanged', () => {
    expect(policy.maxQuoteAgeMs).toBe(60_000);
    // 59s old L2 quote is fresh.
    const fresh = evaluateFreshness({ nowMs: T0, quoteTimestampMs: T0 - 59_000, observedAtMs: T0, policy });
    expect(fresh.fresh).toBe(true);
    // 61s old L2 quote is stale.
    const stale = evaluateFreshness({ nowMs: T0, quoteTimestampMs: T0 - 61_000, observedAtMs: T0, policy });
    expect(stale.fresh).toBe(false);
    if (!stale.fresh) expect(stale.reason).toBe('QUOTE_STALE');
  });
});
