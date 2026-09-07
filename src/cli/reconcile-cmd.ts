/**
 * `bot reconcile` — reconcile the bot's local order ledger / live-managed state
 * against the exchange's authoritative account state (read-only during analysis;
 * a `--commit` flag enables the deterministic `commitProven()` path).
 *
 * Requires NDAX_ENABLE_AUTHENTICATED_READS=true and valid credentials. Any read
 * failure or discrepancy is reported; trading should pause until the account is
 * brought back into a consistent state. The exchange is authoritative for
 * balances/open orders/history; reconciliation NEVER fabricates identities or
 * converts ambiguous evidence into certainty.
 *
 * Exit codes (existing CLI convention):
 *   0 = READY / successful read-only operation
 *   2 = blocked / RECONCILIATION_REQUIRED / HALTED
 *   1 = unexpected program error
 */

import { loadConfig } from '../config/load.js';
import { createExchange } from '../exchanges/index.js';
import { OrderStore, ManagedStateStore } from '../persistence/index.js';
import { ManualIntentStore } from '../manual/index.js';
import { reconcile, commitProven, type ReconciliationDeps } from '../reconcile/index.js';
import type { CommandHandler } from './context.js';

export const reconcileCommand: CommandHandler = async (args): Promise<number> => {
  const commitRequested = args.includes('--commit');

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
    console.error('Reconciliation needs authenticated account reads, but NDAX_ENABLE_AUTHENTICATED_READS is not "true".');
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

  const deps: ReconciliationDeps = {
    stateDir: cfg.stateDir,
    orders: new OrderStore(cfg.orderLedgerFile),
    live: new ManagedStateStore(cfg.liveManagedStateFile),
    manualIntents: new ManualIntentStore(cfg.manualIntentFile),
    adapter,
  };

  let result;
  try {
    result = await reconcile(deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Reconciliation failed: ' + message);
    return 1;
  }

  // eslint-disable-next-line no-console
  console.log('\nReconciliation result');
  // eslint-disable-next-line no-console
  console.log('  Status:           ' + result.status);
  // eslint-disable-next-line no-console
  console.log('  Orders:           ' + result.orderFindings.length);
  // eslint-disable-next-line no-console
  console.log('  Executions:       ' + result.executionFindings.length);
  // eslint-disable-next-line no-console
  console.log('  Reservations:     ' + result.reservationFindings.length);
  // eslint-disable-next-line no-console
  console.log('  Balances:         ' + result.balanceFindings.length);
  // eslint-disable-next-line no-console
  console.log('  Operator findings:' + result.operatorFindings.length);
  // eslint-disable-next-line no-console
  console.log('  Proven to commit: ' + result.commitCandidates.length);

  for (const o of result.orderFindings) {
    if (o.disposition !== 'CONFIRMED') {
      // eslint-disable-next-line no-console
      console.log(`  [order] ${o.clientOrderId} local=${o.localStatus} exchange=${o.exchangeStatus ?? 'unknown'} disposition=${o.disposition} completeness=${o.completeness} ${o.reason}`);
    }
  }
  for (const e of result.executionFindings) {
    if (e.correlation !== 'PROVEN') {
      // eslint-disable-next-line no-console
      console.log(`  [exec] ${e.executionId ?? 'no-id'} order=${e.orderId ?? 'no-order'} corr=${e.correlation} fee=${e.feeDisposition} ${e.reason}`);
    }
  }
  for (const r of result.reservationFindings) {
    if (r.disposition !== 'RETAIN') {
      // eslint-disable-next-line no-console
      console.log(`  [resv] ${r.orderId} disposition=${r.disposition}`);
    }
  }
  for (const b of result.balanceFindings) {
    if (b.mismatch) {
      // eslint-disable-next-line no-console
      console.log(`  [bal] ${b.currency} expected=${b.expected?.toString() ?? 'none'} observed=${b.observed?.toString() ?? 'none'} ${b.reason}`);
    }
  }
  for (const op of result.operatorFindings) {
    // eslint-disable-next-line no-console
    console.log(`  [operator] ${op.kind}: ${op.detail}`);
  }
  for (const reason of result.reasons) {
    // eslint-disable-next-line no-console
    console.log(`  [note] ${reason}`);
  }

  if (commitRequested && result.canCommit) {
    // eslint-disable-next-line no-console
    console.log('\nApplying PROVEN execution accounting (commitProven)...');
    let committed;
    try {
      committed = commitProven(deps, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('Commit failed: ' + message);
      return 2;
    }
    if (committed.status === 'HALTED') {
      // eslint-disable-next-line no-console
      console.error('Commit refused: ' + committed.reasons.join('; '));
      return 2;
    }
    // eslint-disable-next-line no-console
    console.log('  Committed ' + result.commitCandidates.length + ' proven execution(s) and ' + result.reservationReleases.length + ' safe release(s).');
  }

  if (result.status === 'READY') {
    // eslint-disable-next-line no-console
    console.log('\n  Account is consistent. READY.');
    return 0;
  }
  // eslint-disable-next-line no-console
  console.log('\n  STOP trading and resolve discrepancies before placing new orders.');
  return 2;
};
