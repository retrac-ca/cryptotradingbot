/**
 * `bot reconcile` — reconcile the bot's local order ledger against the
 * exchange's authoritative account state (read-only; never places/cancels).
 *
 * Requires NDAX_ENABLE_AUTHENTICATED_READS=true and valid credentials. Any
 * read failure or discrepancy is reported; trading should pause until the
 * account is brought back into a consistent state. The exchange is
 * authoritative for balances/open orders/history.
 */

import { loadConfig } from '../config/load.js';
import { createExchange } from '../exchanges/index.js';
import { OrderStore } from '../persistence/index.js';
import { ReconcileService } from '../reconcile/index.js';
import type { CommandHandler } from './context.js';

export const reconcileCommand: CommandHandler = async (): Promise<number> => {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + message);
    return 1;
  }

  if (!cfg.enableAuthenticatedReads) {
    // eslint-disable-next-line no-console
    console.error(
      'Reconciliation needs authenticated account reads, but NDAX_ENABLE_AUTHENTICATED_READS is not "true".',
    );
    return 1;
  }

  const credentials: Record<string, string> = {
    apiKey: cfg.ndaxApiKey,
    apiSecret: cfg.ndaxApiSecret,
    userId: cfg.ndaxUserId,
    userName: cfg.ndaxUserName,
  };
  if (cfg.ndaxAccountId !== undefined) credentials.accountId = String(cfg.ndaxAccountId);
  const adapter = createExchange(cfg.exchange, {
    credentials,
    config: {
      enableAuthenticatedReads: true,
      baseUrl: cfg.ndaxRestBaseUrl,
    },
  });

  const store = new OrderStore(cfg.orderLedgerFile);
  const service = new ReconcileService(adapter, store);

  // eslint-disable-next-line no-console
  console.log('Fetching authoritative account state from ' + cfg.exchange + '...');
  const report = await service.reconcile();

  // eslint-disable-next-line no-console
  console.log('\nReconciliation result');
  // eslint-disable-next-line no-console
  console.log('  Consistent:        ' + (report.consistent ? 'YES' : 'NO'));
  // eslint-disable-next-line no-console
  console.log('  Safe to trade:     ' + (report.safeToTrade ? 'YES' : 'NO'));
  // eslint-disable-next-line no-console
  console.log('  Balances:          ' + report.balances.length);
  // eslint-disable-next-line no-console
  console.log('  Open orders:       ' + report.openOrders.length);
  // eslint-disable-next-line no-console
  console.log('  Orders matched by client id:  ' + report.ordersMatchedByClientId);
  // eslint-disable-next-line no-console
  console.log('  Orders matched by exchange id: ' + report.ordersMatchedByExchangeId);

  if (report.discrepancies.length === 0) {
    // eslint-disable-next-line no-console
    console.log('\n  No discrepancies. Account is consistent with the bot ledger.');
  } else {
    // eslint-disable-next-line no-console
    console.log('\n  Discrepancies (' + report.discrepancies.length + '):');
    for (const d of report.discrepancies) {
      // eslint-disable-next-line no-console
      console.log(`    [${d.kind}] ${d.detail ?? ''} ${d.clientOrderId ?? ''}`);
    }
    // eslint-disable-next-line no-console
    console.log('\n  STOP trading and resolve discrepancies before placing new orders.');
  }

  return report.safeToTrade ? 0 : 2;
};
