/**
 * `bot status` — show current bot / paper state.
 *
 * Reports effective configuration plus the persisted PAPER portfolio when one
 * exists (loaded from the configured state file). If no engine has run yet,
 * reports that.
 */

import { loadConfig } from '../config/load.js';
import { PaperStateStore } from '../persistence/index.js';
import type { CommandHandler } from './context.js';

export const statusCommand: CommandHandler = (): number => {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + message);
    return 1;
  }

  // eslint-disable-next-line no-console
  console.log('Bot status');
  // eslint-disable-next-line no-console
  console.log('  Trading mode:   ' + cfg.tradingMode.toUpperCase());
  // eslint-disable-next-line no-console
  console.log('  Kill switch:    ' + (cfg.killSwitch ? 'ENABLED (trading blocked)' : 'disabled'));
  // eslint-disable-next-line no-console
  console.log('  Exchange:       ' + cfg.exchange);
  // eslint-disable-next-line no-console
  console.log('  Pairs:          ' + cfg.tradingPairs.join(', '));
  // eslint-disable-next-line no-console
  console.log('  State file:     ' + cfg.paperStateFile);

  const store = new PaperStateStore(cfg.paperStateFile);
  const state = store.load();
  if (!state) {
    // eslint-disable-next-line no-console
    console.log('\n  Paper portfolio: no state saved yet (run "bot paper" to begin).');
    return 0;
  }

  // eslint-disable-next-line no-console
  console.log('\n  Paper portfolio (persisted):');
  for (const [currency, amount] of Object.entries(state.cash)) {
    // eslint-disable-next-line no-console
    console.log(`    Cash ${currency}: ${amount}`);
  }
  for (const [symbol, p] of Object.entries(state.positions)) {
    // eslint-disable-next-line no-console
    console.log(
      `    Position ${symbol}: ${p.quantity} @ ${p.averageEntryPrice} (cost basis ${p.costBasis})`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`    Realized P&L:  ${state.realizedPnl}`);
  // eslint-disable-next-line no-console
  console.log(`    Fees paid:     ${state.totalFees}`);
  // eslint-disable-next-line no-console
  console.log(`    Peak equity:   ${state.peakEquity}`);
  // eslint-disable-next-line no-console
  console.log(`  Executed orders on record: ${state.executedOrderIds.length}`);
  return 0;
};
