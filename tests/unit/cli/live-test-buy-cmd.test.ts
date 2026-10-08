/**
 * `bot live-test buy` — supervised controlled BUY command.
 *
 * These tests use FakeExchange. The controlled-placement readiness facts are
 * DERIVED from actual observations, so the tests set the fake's
 * `supportsOrderPlacement=false` (the general-adapter invariant) and otherwise
 * let production readiness evaluate. No real order is ever placed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ManagedStateStore } from '../../../src/persistence/ManagedStateStore.js';
import { ManualIntentStore } from '../../../src/manual/ManualIntentStore.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { buildRiskManager } from '../../../src/risk/index.js';
import type { BotConfig } from '../../../src/config/schema.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { executeLiveBuy, parseLiveTestBuyArgs, isExecuteConfirmation } from '../../../src/cli/live-test-cmd.js';
import type { LiveTestDeps } from '../../../src/cli/live-test-cmd.js';
import type { MarketInfo, Ticker } from '../../../src/types.js';
import type { Order } from '../../../src/order.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('livebuy', 'ledger.json');
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
    cooldownAfterLossSeconds: 0,
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

interface BuildOpts {
  cfg?: Partial<BotConfig>;
  adapter?: (e: FakeExchange) => void;
  confirm?: (m: string) => Promise<boolean>;
  portfolio?: Portfolio;
  nowMs?: () => number;
  /** Advertise general placement (defaults false, the controlled-adapter invariant). */
  supportsOrderPlacement?: boolean;
  omitConfirm?: boolean;
}

interface BuyDeps extends LiveTestDeps {
  adapter: FakeExchange;
}

/** Load the durable managed portfolio (test helper; throws on non-OK). */
function loadManaged(store: ManagedStateStore): Portfolio {
  const r = store.load();
  if (r.status !== 'OK') throw new Error(`expected OK live managed state, got ${r.status}`);
  const p = store.toPortfolio(r.data);
  if (!p) throw new Error('could not reconstruct managed portfolio');
  return p;
}

function seededLiveOrder(status: Order['status'], clientOrderId = 'live-BTCCAD-seeded'): Order {
  return {
    clientOrderId,
    exchangeOrderId: null,
    symbol: SYMBOL,
    side: 'BUY',
    type: 'limit',
    status,
    quantity: Money.fromString('0.001'),
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: Money.fromString('40000'),
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'unknown',
    reason: 'seed',
    createdAtMs: T0,
    updatedAtMs: T0,
  };
}

function buildDeps(over: BuildOpts = {}): BuyDeps {
  rmSync(LEDGER, { force: true });
  rmSync(LIVE_FILE, { force: true });
  rmSync(INTENTS_FILE, { force: true });
  // The BUY happy-path tests intentionally keep the live quote cap large so the
  // risk position fraction (not the LIVE cap) bounds the size; the LIVE caps
  // themselves are covered by engine/scope tests.
  const c = cfg({ liveMaxQuoteNotional: 1000, liveMaxBaseQuantity: 10, ...over.cfg });
  const adapter = new FakeExchange({
    balances: { CAD: '1000' },
    markets: { [SYMBOL]: market },
    tickers: { [SYMBOL]: ticker() },
  });
  // The controlled BUY path requires the GENERAL adapter to NOT advertise
  // autonomous placement; the controlled authorization is the exception.
  (adapter.capabilities as { supportsOrderPlacement: boolean }).supportsOrderPlacement =
    over.supportsOrderPlacement ?? false;
  over.adapter?.(adapter);
  const store = new OrderStore(LEDGER);
  const reconcile = new ReconcileService(adapter, store);
  const riskManager = buildRiskManager(c);
  const portfolio = over.portfolio ?? Portfolio.empty(new Map([['CAD', Money.fromString('1000')]]));
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
    ...(over.omitConfirm ? {} : { confirm: over.confirm ?? (async () => true) }),
    nowMs: over.nowMs ?? (() => T0),
  };
}

const OPTS = { confirmLive: true };

describe('parseLiveTestBuyArgs', () => {
  it('requires the buy subcommand and parses --confirm-live', () => {
    expect(parseLiveTestBuyArgs([]).ok).toBe(false);
    expect(parseLiveTestBuyArgs(['sell']).ok).toBe(false);
    const r = parseLiveTestBuyArgs(['buy', '--confirm-live']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.opts.confirmLive).toBe(true);
  });

  it('rejects quantity/price/size injection and unknown flags', () => {
    for (const args of [['buy', '--quantity', '1'], ['buy', '--target-cad', '5'], ['buy', '--price', '1'], ['buy', '--bogus']]) {
      expect(parseLiveTestBuyArgs(args).ok).toBe(false);
    }
  });

  it('parses --check as a read-only preflight that does not require --confirm-live', () => {
    const r = parseLiveTestBuyArgs(['buy', '--check']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.opts.check).toBe(true);
      expect(r.opts.confirmLive).toBe(false);
    }
  });
});

describe('operator confirmation — exact EXECUTE only', () => {
  it('accepts only the exact EXECUTE token (case-insensitive, whitespace-trimmed)', () => {
    expect(isExecuteConfirmation('EXECUTE')).toBe(true);
    expect(isExecuteConfirmation('  execute  ')).toBe(true);
    expect(isExecuteConfirmation('Execute')).toBe(true);
  });

  it('refuses anything other than EXECUTE', () => {
    for (const answer of ['', ' ', 'yes', 'y', 'EXECUT', 'EXECUTE NOW', 'EXECUTE!', 'no', 'confirm']) {
      expect(isExecuteConfirmation(answer), `expected "${answer}" to be refused`).toBe(false);
    }
  });
});

describe('executeLiveBuy — controlled readiness', () => {
  it('reaches readiness and places exactly one BUY when all required conditions hold', async () => {
    const deps = buildDeps();
    const led = await executeLiveBuy(deps, OPTS);
    expect(led).toBe(0);
    expect(deps.adapter.submittedOrders).toHaveLength(1);
    expect(deps.adapter.submittedOrders[0]!.side).toBe('BUY');
  });

  it('refuses when the adapter advertises general order placement (supportsOrderPlacement=true)', async () => {
    const deps = buildDeps({ supportsOrderPlacement: true });
    expect(await executeLiveBuy(deps, OPTS)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
    expect(deps.store.allOrders().size).toBe(0);
  });

  it('blocks on an unresolved local live order before any exchange contact', async () => {
    const deps = buildDeps();
    deps.store.save(seededLiveOrder('CREATED'));
    expect(await executeLiveBuy(deps, OPTS)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });
});

describe('executeLiveBuy — pre-contact gates', () => {
  it('refuses in paper mode', async () => {
    const deps = buildDeps({ cfg: { tradingMode: 'paper' } });
    expect(await executeLiveBuy(deps, OPTS)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('refuses without --confirm-live', async () => {
    const deps = buildDeps();
    expect(await executeLiveBuy(deps, { confirmLive: false })).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('refuses when the kill switch is on', async () => {
    const deps = buildDeps({ cfg: { killSwitch: true } });
    expect(await executeLiveBuy(deps, OPTS)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('refuses when authenticated reads are disabled', async () => {
    const deps = buildDeps({ cfg: { enableAuthenticatedReads: false } });
    expect(await executeLiveBuy(deps, OPTS)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });
});

describe('executeLiveBuy — risk, reconciliation, freshness', () => {
  it('refuses on stale market data', async () => {
    const deps = buildDeps({
      adapter: (e) => e.setTicker(SYMBOL, { bid: Money.fromString('40000'), ask: Money.fromString('40001'), last: Money.fromString('40000'), timestampMs: T0 - 3600_000 }),
    });
    expect(await executeLiveBuy(deps, OPTS)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('BLOCKS a BUY when external/unmanaged CAD makes the quote reconcile mismatch', async () => {
    // Managed CAD 1000; exchange CAD 2000 (1000 external). The bot must not
    // deploy external CAD, so the BUY quote reconciliation blocks.
    const deps = buildDeps({ adapter: (e) => e.setBalance('CAD', '2000') });
    expect(await executeLiveBuy(deps, OPTS)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
    expect(deps.store.allOrders().size).toBe(0);
  });

  it('does not automatically adopt external CAD even when it would enable the BUY', async () => {
    const deps = buildDeps({ adapter: (e) => e.setBalance('CAD', '100000') });
    expect(await executeLiveBuy(deps, OPTS)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
    // Managed CAD is unchanged in the durable store.
    expect(loadManaged(deps.live).cash('CAD').toString()).toBe('1000.00000000');
  });
});

describe('executeLiveBuy — operator confirmation', () => {
  it('readiness is evaluated BEFORE confirmation (declined confirmation places no order)', async () => {
    const deps = buildDeps({ confirm: async () => false });
    expect(await executeLiveBuy(deps, OPTS)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
    expect(loadManaged(deps.live).orderReservationsView().size).toBe(0);
  });

  it('requires a non-TTY-safe default confirmation (no TTY => refuse)', async () => {
    if (process.stdin.isTTY) return; // only meaningful in a non-TTY test runner
    const deps = buildDeps({ omitConfirm: true });
    expect(await executeLiveBuy(deps, OPTS)).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });
});

describe('executeLiveBuy — happy path (fake exchange)', () => {
  it('reserves managed CAD BEFORE submitting and places exactly one BUY LIMIT', async () => {
    let reservationAtSubmit: string | null = null;
    let prompt = '';
    let liveRef!: ManagedStateStore;
    const deps = buildDeps({
      confirm: async (m) => {
        prompt = m;
        return true;
      },
      adapter: (e) => {
        const orig = e.placeOrder.bind(e);
        (e as unknown as { placeOrder: typeof e.placeOrder }).placeOrder = async (order, auth) => {
          const r = liveRef.load();
          const p = r.status === 'OK' ? liveRef.toPortfolio(r.data) : null;
          reservationAtSubmit = p?.orderReservation(order.clientOrderId)?.status ?? null;
          return orig(order, auth);
        };
      },
    });
    liveRef = deps.live;

    const led = await executeLiveBuy(deps, OPTS);
    expect(led).toBe(0);
    expect(deps.adapter.submittedOrders).toHaveLength(1);
    const submitted = deps.adapter.submittedOrders[0]!;
    expect(submitted.side).toBe('BUY');
    expect(submitted.type).toBe('limit');
    // The durable reservation existed (ACTIVE) at the moment of submission.
    expect(reservationAtSubmit).toBe('ACTIVE');
    // The exact order was displayed before confirmation.
    expect(prompt).toContain('BUY');
    expect(prompt).toContain('LIMIT');
    expect(prompt).toContain(submitted.quantity.toString());
    expect(prompt).toContain(submitted.price!.toFixed(8));
    // The reservation remains committed after an acknowledgement (not terminal).
    const res = loadManaged(deps.live).orderReservation(submitted.clientOrderId);
    expect(res?.status).toBe('ACTIVE');
    expect(res!.amount.isPositive()).toBe(true);
  });

  it('releases the reservation on a definite rejection', async () => {
    const deps = buildDeps({
      adapter: (e) => e.setFailures({ placeOrder: { kind: 'rejected' } }),
    });
    const led = await executeLiveBuy(deps, OPTS);
    expect(led).toBe(1);
    const submittedAny = deps.store.allOrders().values().next().value;
    expect(submittedAny?.status).toBe('REJECTED');
    // Reservation released (no ACTIVE reservation remains).
    const p = loadManaged(deps.live);
    expect(p.orderReservation(submittedAny!.clientOrderId)?.status).toBe('RELEASED');
    expect(p.reserved('CAD').isZero()).toBe(true);
  });

  it('keeps the reservation ACTIVE on an UNKNOWN submission and does not retry', async () => {
    const deps = buildDeps({
      adapter: (e) => {
        // Simulate an ambiguous acknowledgement.
        (e as unknown as { unknownOrderSubmissions: boolean }).unknownOrderSubmissions = true;
      },
    });
    const led = await executeLiveBuy(deps, OPTS);
    expect(led).toBe(1);
    // Exactly one attempt; no retry.
    expect(deps.adapter.submittedOrders).toHaveLength(1);
    const order = deps.store.allOrders().values().next().value!;
    expect(order.status).toBe('UNKNOWN');
    expect(loadManaged(deps.live).orderReservation(order.clientOrderId)?.status).toBe('ACTIVE');
  });

  it('aborts rather than repricing when the prepared order goes stale before submit', async () => {
    let clock = T0;
    const deps = buildDeps({
      nowMs: () => clock,
      confirm: async () => {
        clock += 5 * 60_000; // beyond the 60s freshness window
        return true;
      },
    });
    const led = await executeLiveBuy(deps, OPTS);
    expect(led).toBe(1);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
    // No CREATED order and no reservation were persisted.
    expect(deps.store.allOrders().size).toBe(0);
    expect(loadManaged(deps.live).orderReservationsView().size).toBe(0);
  });
});

describe('executeLiveBuy --check — read-only BUY preflight', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureLogs(): () => string {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    return () => spy.mock.calls.map((c) => c.join(' ')).join('\n');
  }

  it('reaches the preflight and returns 0 (READY) without any mutation or prompt', async () => {
    const confirm = vi.fn(async () => true);
    const deps = buildDeps({ confirm });
    const output = captureLogs();

    const led = await executeLiveBuy(deps, { confirmLive: false, check: true });

    expect(led).toBe(0);
    const text = output();
    expect(text).toContain('BUY PREFLIGHT: READY');
    expect(text).toContain('Informational findings:');
    expect(text).toContain('Compensating controls');
    // Never prompts for EXECUTE.
    expect(confirm).not.toHaveBeenCalled();
    // Never calls placeOrder.
    expect(deps.adapter.submittedOrders).toHaveLength(0);
    // Never persists an order.
    expect(deps.store.allOrders().size).toBe(0);
    // Never creates a reservation.
    expect(loadManaged(deps.live).orderReservationsView().size).toBe(0);
  });

  it('returns non-zero (BLOCKED) when the BUY would be blocked, still mutating nothing', async () => {
    // External/unmanaged CAD makes the BUY quote reconcile mismatch -> blocked.
    const deps = buildDeps({ adapter: (e) => e.setBalance('CAD', '2000') });
    const output = captureLogs();

    const led = await executeLiveBuy(deps, { confirmLive: false, check: true });

    expect(led).toBe(1);
    expect(output()).toContain('BUY PREFLIGHT: BLOCKED');
    expect(deps.adapter.submittedOrders).toHaveLength(0);
    expect(deps.store.allOrders().size).toBe(0);
    expect(loadManaged(deps.live).orderReservationsView().size).toBe(0);
  });

  it('does not require --confirm-live and never prompts even with no confirm handler', async () => {
    const deps = buildDeps({ omitConfirm: true });
    captureLogs();
    const led = await executeLiveBuy(deps, { confirmLive: false, check: true });
    expect(led).toBe(0);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
  });

  it('does not mint a usable live authorization (a hard placeOrder failure is never reached)', async () => {
    // If --check reached submission it would call placeOrder, which is made to
    // fail loudly here. No submission, no persisted order, no reservation.
    const deps = buildDeps({ adapter: (e) => e.setFailures({ placeOrder: { kind: 'network' } }) });
    captureLogs();

    const led = await executeLiveBuy(deps, { confirmLive: false, check: true });

    expect(led).toBe(0);
    expect(deps.adapter.submittedOrders).toHaveLength(0);
    expect(deps.store.allOrders().size).toBe(0);
    expect(loadManaged(deps.live).orderReservationsView().size).toBe(0);
  });

  it('blocks on a pre-contact gate (kill switch) and never contacts order placement', async () => {
    const deps = buildDeps({ cfg: { killSwitch: true } });
    const output = captureLogs();

    const led = await executeLiveBuy(deps, { confirmLive: false, check: true });

    expect(led).toBe(1);
    expect(output()).toContain('BUY PREFLIGHT: BLOCKED');
    expect(deps.adapter.submittedOrders).toHaveLength(0);
    expect(deps.store.allOrders().size).toBe(0);
  });
});

describe('live-test buy — no continuous/autonomous path', () => {
  it('the command module never imports the paper engine or the paper runner', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../../src/cli/live-test-cmd.ts'), 'utf8');
    expect(src).not.toContain('PaperEngine');
    expect(src).not.toContain('runPaperEngine');
    expect(src).not.toContain('runLiveStart');
  });

  it('mints the controlled authorization from a single mint helper (auditable boundary)', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../../src/cli/live-test-cmd.ts'), 'utf8');
    const occurrences = src.split('createControlledLiveAuthorization({').length - 1;
    expect(occurrences).toBe(1);
  });
});
