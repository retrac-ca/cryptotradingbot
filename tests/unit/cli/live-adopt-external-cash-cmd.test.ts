/**
 * `bot live-adopt-external-cash` — external quote cash ownership adoption.
 *
 * This command reclassifies pre-existing EXTERNAL exchange quote cash as
 * BOT-managed deployable capital. It must ONLY mutate the local LIVE managed
 * portfolio, never the exchange. These tests verify the safety boundary without
 * ever contacting a real exchange (FakeExchange only).
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { botConfigSchema } from '../../../src/config/schema.js';
import {
  executeLiveAdoptExternalCash,
  parseLiveAdoptExternalCashArgs,
} from '../../../src/cli/live-adopt-external-cash-cmd.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import type { BotConfig } from '../../../src/config/schema.js';
import type { MarketInfo } from '../../../src/types.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('live-adopt-cash', 'ledger.json');
const SYMBOL = 'BTC/CAD';
const MANAGED_CAD = '100000';

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
    liveMonitorIntervalSeconds: 30,
    logLevel: 'info',
    reconcileIntervalSeconds: 60,
    killSwitch: false,
    orderLedgerFile: LEDGER,
    ...over,
  } as BotConfig;
}

function makePortfolio(managed = MANAGED_CAD): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString(managed)]]));
}

interface BuiltDeps {
  deps: Parameters<typeof executeLiveAdoptExternalCash>[0];
  exchange: FakeExchange;
  saved: Portfolio[];
  getPortfolio: () => Portfolio;
}

function buildDeps(over: {
  cfg?: Partial<BotConfig>;
  exchangeCad?: string;
  portfolio?: Portfolio;
  confirm?: (message: string) => Promise<boolean>;
} = {}): BuiltDeps {
  const c = cfg(over.cfg);
  const exchange = new FakeExchange({
    balances: { BTC: '0.00034411', CAD: over.exchangeCad ?? '100026.02273575' },
    markets: { [SYMBOL]: market },
  });
  let portfolio = over.portfolio ?? makePortfolio();
  const saved: Portfolio[] = [];
  const deps = {
    cfg: c,
    adapter: exchange,
    getPortfolio: () => portfolio,
    savePortfolio: (p: Portfolio) => {
      portfolio = p;
      saved.push(p);
    },
    confirm: over.confirm ?? (async () => true),
    nowMs: () => 1_000_000,
  };
  return { deps, exchange, saved, getPortfolio: () => portfolio };
}

describe('live-adopt-external-cash — safety gates', () => {
  it('refuses to operate against PAPER state', async () => {
    const { deps } = buildDeps({ cfg: { tradingMode: 'paper' } });
    expect(await executeLiveAdoptExternalCash(deps)).toBe(1);
    expect(deps.getPortfolio().cash('CAD').toFixed(8)).toBe('100000.00000000');
  });

  it('preserves the kill switch (refuses when active)', async () => {
    const { deps, saved } = buildDeps({ cfg: { killSwitch: true } });
    expect(await executeLiveAdoptExternalCash(deps)).toBe(1);
    expect(saved).toHaveLength(0);
  });

  it('requires authenticated exchange reads', async () => {
    const { deps, saved } = buildDeps({ cfg: { enableAuthenticatedReads: false } });
    expect(await executeLiveAdoptExternalCash(deps)).toBe(1);
    expect(saved).toHaveLength(0);
  });

  it('requires exactly one configured trading pair', async () => {
    const { deps } = buildDeps({ cfg: { tradingPairs: [SYMBOL, 'ETH/CAD'] } });
    expect(await executeLiveAdoptExternalCash(deps)).toBe(1);
  });
});

describe('live-adopt-external-cash — exchange read & amount', () => {
  it('adopts exactly the external residual into managed cash', async () => {
    const { deps } = buildDeps();
    expect(await executeLiveAdoptExternalCash(deps)).toBe(0);
    expect(deps.getPortfolio().cash('CAD').toFixed(8)).toBe('100026.02273575');
  });

  it('never adopts more than the verified exchange balance', async () => {
    const { deps } = buildDeps();
    await executeLiveAdoptExternalCash(deps);
    expect(deps.getPortfolio().cash('CAD').compareTo(Money.fromString('100026.02273575'))).toBe(0);
  });

  it('rejects when there is no external residual (exchange == managed)', async () => {
    const { deps, saved } = buildDeps({ exchangeCad: MANAGED_CAD });
    expect(await executeLiveAdoptExternalCash(deps)).toBe(1);
    expect(saved).toHaveLength(0);
  });

  it('rejects when the exchange reports less than managed', async () => {
    const { deps, saved } = buildDeps({ exchangeCad: '5' });
    expect(await executeLiveAdoptExternalCash(deps)).toBe(1);
    expect(saved).toHaveLength(0);
  });

  it('does not create a position, reservation, execution, or settlement', async () => {
    const { deps } = buildDeps();
    await executeLiveAdoptExternalCash(deps);
    const model = deps.getPortfolio().stateModel;
    expect(model.positions.size).toBe(0);
    expect(model.orderReservations.size).toBe(0);
    expect(model.appliedExecutions.size).toBe(0);
    expect(model.manualSettlements.size).toBe(0);
    expect(model.cash.get('CAD')!.toFixed(8)).toBe('100026.02273575');
  });

  it('leaves realized P&L unchanged (capital injection is not P&L)', async () => {
    const { deps } = buildDeps();
    await executeLiveAdoptExternalCash(deps);
    expect(deps.getPortfolio().stateModel.realizedPnl.toFixed(8)).toBe('0.00000000');
    expect(deps.getPortfolio().expectedAssetBalances().get('CAD')).toBeUndefined();
  });
});

describe('live-adopt-external-cash — confirmation', () => {
  it('requires operator confirmation (declining aborts without persisting)', async () => {
    const { deps, saved } = buildDeps({ confirm: async () => false });
    expect(await executeLiveAdoptExternalCash(deps)).toBe(1);
    expect(saved).toHaveLength(0);
    expect(deps.getPortfolio().cash('CAD').toFixed(8)).toBe('100000.00000000');
  });
});

describe('live-adopt-external-cash — idempotency', () => {
  it('re-running after adoption fails safely without duplicating capital', async () => {
    const { deps } = buildDeps();
    expect(await executeLiveAdoptExternalCash(deps)).toBe(0);
    expect(await executeLiveAdoptExternalCash(deps)).toBe(1);
    expect(deps.getPortfolio().cash('CAD').toFixed(8)).toBe('100026.02273575');
  });
});

describe('live-adopt-external-cash — TOCTOU', () => {
  it('fails closed when the balance changes after confirmation', async () => {
    const c = cfg();
    const exchange = new FakeExchange({
      balances: { BTC: '0.00034411', CAD: '100026.02273575' },
      markets: { [SYMBOL]: market },
    });
    let portfolio = makePortfolio();
    const saved: Portfolio[] = [];
    const deps = {
      cfg: c,
      adapter: exchange,
      getPortfolio: () => portfolio,
      savePortfolio: (p: Portfolio) => {
        portfolio = p;
        saved.push(p);
      },
      // The balance changes AFTER the first read (during confirmation).
      confirm: async () => {
        exchange.setBalance('CAD', '100050.00000000');
        return true;
      },
      nowMs: () => 1_000_000,
    };
    expect(await executeLiveAdoptExternalCash(deps)).toBe(1);
    expect(saved).toHaveLength(0);
    expect(portfolio.cash('CAD').toFixed(8)).toBe('100000.00000000');
  });
});

describe('live-adopt-external-cash — no mutation path', () => {
  it('does not place or cancel any order', async () => {
    const { deps, exchange } = buildDeps();
    expect(await executeLiveAdoptExternalCash(deps)).toBe(0);
    expect(exchange.submittedOrders).toHaveLength(0);
  });
});

describe('live-adopt-external-cash — no bypass', () => {
  it('rejects --yes / --force and any arguments (no bypass)', () => {
    expect(parseLiveAdoptExternalCashArgs(['--yes']).ok).toBe(false);
    expect(parseLiveAdoptExternalCashArgs(['--force']).ok).toBe(false);
    expect(parseLiveAdoptExternalCashArgs(['26.02']).ok).toBe(false);
    expect(parseLiveAdoptExternalCashArgs([]).ok).toBe(true);
  });

  it('no config/env schema field can authorize adoption unattended', () => {
    const shape = botConfigSchema.shape as Record<string, unknown>;
    expect(shape).not.toHaveProperty('adoptExternalCash');
    expect(shape).not.toHaveProperty('adoptQuote');
    expect(shape).not.toHaveProperty('liveAdoptExternalCash');
  });
});
