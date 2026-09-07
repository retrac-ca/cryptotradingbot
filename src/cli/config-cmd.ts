/**
 * `bot config` — show the effective resolved configuration.
 *
 * Loads and validates the config, then prints all NON-SECRET values. Secrets
 * (API key/secret) are never printed.
 */

import { loadConfig } from '../config/load.js';
import type { CommandHandler } from './context.js';

export const configureCommand: CommandHandler = (): number => {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Config could not be loaded:\n' + message);
    return 1;
  }

  // eslint-disable-next-line no-console
  console.log('Resolved configuration:');
  // eslint-disable-next-line no-console
  console.log('  Mode:            ' + cfg.tradingMode.toUpperCase());
  // eslint-disable-next-line no-console
  console.log('  Exchange:        ' + cfg.exchange);
  // eslint-disable-next-line no-console
  console.log('  Trading pairs:   ' + cfg.tradingPairs.join(', '));
  // eslint-disable-next-line no-console
  console.log('  Universe:        ' + cfg.universeMarkets.join(', '));
  // eslint-disable-next-line no-console
  console.log('  Strategy:        ' + cfg.strategy);
  // eslint-disable-next-line no-console
  console.log('  Timeframe:       ' + cfg.timeframe);
  if (cfg.strategy === 'moving-average-crossover') {
    // eslint-disable-next-line no-console
    console.log('    MA fast/slow:  ' + cfg.maFastPeriod + '/' + cfg.maSlowPeriod);
  }
  // eslint-disable-next-line no-console
  console.log('  Risk:');
  // eslint-disable-next-line no-console
  console.log('    Max pos frac:  ' + cfg.maxPositionSizeFraction);
  // eslint-disable-next-line no-console
  console.log('    Max trade:     ' + (cfg.maxTradeAmount > 0 ? cfg.maxTradeAmount : 'unlimited') + ' (quote)');
  // eslint-disable-next-line no-console
  console.log('    Max positions: ' + cfg.maxOpenPositions + (cfg.maxOpenPositions <= 0 ? ' (no limit)' : ' (enforced)'));
  // eslint-disable-next-line no-console
  console.log('    Max daily loss:' + cfg.maxDailyLossFraction);
  // eslint-disable-next-line no-console
  console.log('    Data max age:  ' + cfg.marketDataMaxAgeMs + 'ms');
  // eslint-disable-next-line no-console
  console.log('    Transport age: ' + cfg.marketDataTransportMaxAgeMs + 'ms');
  // eslint-disable-next-line no-console
  console.log('    Clock skew:    ' + cfg.maxClockSkewMs + 'ms');
  // eslint-disable-next-line no-console
  console.log('    Stop loss:     ' + cfg.stopLossFraction + ' (NOT ENFORCED yet)');
  // eslint-disable-next-line no-console
  console.log('    Take profit:   ' + cfg.takeProfitFraction + ' (NOT ENFORCED yet)');
  // eslint-disable-next-line no-console
  console.log('  System:');
  // eslint-disable-next-line no-console
  console.log('    Log level:     ' + cfg.logLevel);
  // eslint-disable-next-line no-console
  console.log('    Reconcile sec: ' + cfg.reconcileIntervalSeconds);
  // eslint-disable-next-line no-console
  console.log('    Kill switch:   ' + cfg.killSwitch);
  // eslint-disable-next-line no-console
  console.log('    Paper state:   ' + cfg.paperStateFile);
  // eslint-disable-next-line no-console
  console.log('    Live managed:  ' + cfg.liveManagedStateFile + ' (separate from paper state)');
  // eslint-disable-next-line no-console
  console.log('\n(API credentials are not displayed.)');
  return 0;
};
