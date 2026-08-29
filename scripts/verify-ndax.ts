#!/usr/bin/env tsx
/**
 * Non-destructive NDAX verification probe.
 *
 * Runs ONLY read-only calls:
 *   public:  Ping, GetInstruments, GetLevel1, GetL2Snapshot, GetTickerHistory
 *   private: GetUserAccounts, GetAccountPositions, GetOpenOrders, GetOrderHistory
 *            (only when ENABLE_AUTHENTICATED_READS=true and credentials exist)
 *
 * It NEVER places, cancels, or edits orders and never prints secrets.
 * Usage: npm run verify:ndax
 */

import { loadConfig } from '../src/config/load.js';
import { NdaxAdapter } from '../src/exchanges/ndax/NdaxAdapter.js';

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<number> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error('Config error:', err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log('NDAX read-only verification — no orders will ever be placed.\n');

  const adapter = new NdaxAdapter({
    credentials: {
      apiKey: cfg.ndaxApiKey,
      apiSecret: cfg.ndaxApiSecret,
      userId: cfg.ndaxUserId,
      userName: cfg.ndaxUserName,
      accountId: cfg.ndaxAccountId,
    },
    baseUrl: cfg.ndaxRestBaseUrl,
    enableAuthenticatedReads: cfg.enableAuthenticatedReads,
  });

  const results: StepResult[] = [];
  const run = async (name: string, fn: () => Promise<string>): Promise<void> => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
      console.log(`  PASS  ${name}: ${detail}`);
    } catch (err) {
      results.push({ name, ok: false, detail: (err as Error).message });
      console.log(`  FAIL  ${name}: ${(err as Error).message}`);
    }
  };

  await run('health (Ping)', async () => {
    const h = await adapter.health();
    return h.connected ? `connected, ${h.latencyMs}ms` : `not connected: ${h.detail}`;
  });

  await run('GetInstruments', async () => {
    const markets = await adapter.getMarkets();
    const btc = markets.find((m) => m.symbol === 'BTC/CAD');
    if (!btc) return `${markets.length} markets parsed; BTC/CAD NOT found`;
    return (
      `${markets.length} markets; BTC/CAD id=${btc.exchangeId} ` +
      `priceTick=${btc.priceTick.toFixed(8)} qtyTick=${btc.quantityTick.toFixed(8)} ` +
      `minQty=${btc.minOrderBase?.toFixed(8) ?? 'n/a'}`
    );
  });

  await run('GetLevel1 BTC/CAD', async () => {
    const t = await adapter.getTicker('BTC/CAD');
    return `bid=${t.bid?.toFixed(2) ?? 'n/a'} ask=${t.ask?.toFixed(2) ?? 'n/a'} last=${t.last?.toFixed(2) ?? 'n/a'}`;
  });

  await run('GetL2Snapshot BTC/CAD', async () => {
    const book = await adapter.getOrderBook('BTC/CAD', 10);
    return `${book.bids.length} bids / ${book.asks.length} asks`;
  });

  await run('GetTickerHistory BTC/CAD 5m', async () => {
    const candles = await adapter.getCandles('BTC/CAD', '5m', { limit: 5 });
    if (candles.length === 0) return '0 candles returned';
    const last = candles[candles.length - 1]!;
    return `${candles.length} candles; latest ${new Date(last.timestampMs).toISOString()} close=${last.close.toFixed(2)}`;
  });

  if (cfg.enableAuthenticatedReads) {
    console.log('\nAuthenticated reads (ENABLE_AUTHENTICATED_READS=true):');
    if (!cfg.ndaxApiKey || !cfg.ndaxApiSecret || !cfg.ndaxUserId) {
      results.push({ name: 'authenticated-reads', ok: false, detail: 'missing NDAX_API_KEY / NDAX_API_SECRET / NDAX_USER_ID' });
      console.log('  FAIL  authenticated-reads: missing NDAX_API_KEY / NDAX_API_SECRET / NDAX_USER_ID');
    } else {
      await run('GetUserAccounts + GetAccountPositions', async () => {
        const balances = await adapter.getBalances();
        if (balances.length === 0) return 'no balances returned';
        return balances
          .filter((b) => !b.total.isZero() || !b.held.isZero())
          .map((b) => `${b.currency}=${b.total.toFixed(8)}`)
          .join(', ');
      });
      await run('GetOpenOrders', async () => {
        const orders = await adapter.getOpenOrders();
        return `${orders.length} open orders`;
      });
      await run('GetOrderHistory', async () => {
        const orders = await adapter.getOrderHistory();
        return `${orders.length} orders in history`;
      });
    }
  } else {
    console.log('\nAuthenticated reads skipped (ENABLE_AUTHENTICATED_READS=false).');
  }

  console.log('\n' + '-'.repeat(40));
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log(`All ${results.length} read-only checks passed.`);
    console.log('This validates the REST base URL, public endpoints, and (if enabled) signing auth.');
    return 0;
  }
  console.log(`${failed.length}/${results.length} checks failed. Compare against docs/NDAX_API.md.`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });