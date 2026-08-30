/**
 * `bot trades` — show the durable order ledger (every order the bot has
 * attempted, keyed by clientOrderId).
 *
 * This is the bot's own record of intent and observed outcomes. For LIVE
 * trading, always cross-check actual balances/open orders against the exchange;
 * the exchange is authoritative. Persisted by OrderStore.
 */

import { loadConfig } from '../config/load.js';
import { OrderStore } from '../persistence/index.js';
import type { CommandHandler } from './context.js';

export const tradesCommand: CommandHandler = (args): number => {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + message);
    return 1;
  }

  const showOpen = args.includes('--open');
  const store = new OrderStore(cfg.orderLedgerFile);
  const orders = [...store.allOrders().values()].sort((a, b) => a.createdAtMs - b.createdAtMs);

  if (orders.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No orders recorded yet in ' + cfg.orderLedgerFile);
    return 0;
  }

  const filtered = showOpen ? orders.filter((o) => ['OPEN', 'SUBMITTED', 'PARTIALLY_FILLED', 'UNKNOWN'].includes(o.status)) : orders;
  // eslint-disable-next-line no-console
  console.log('Order ledger (' + filtered.length + (showOpen ? ' open' : '') + ' order(s)):');
  for (const o of filtered) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${o.clientOrderId}  ${o.side} ${o.quantity} ${o.symbol}  [${o.type}] ${o.status}  ` +
        `exch=${o.exchangeOrderId ?? '-'}  filled=${o.filledQuantity}`,
    );
  }
  return 0;
};
