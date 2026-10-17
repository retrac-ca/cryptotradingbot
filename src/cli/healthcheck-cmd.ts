/**
 * `bot healthcheck` — READ-ONLY deployment health check.
 *
 * Verifies local durable state, the mutation lock, engine heartbeat freshness,
 * the equity curve, and dashboard liveness. It never contacts the exchange,
 * never mutates state, and never places/cancels/resolves an order.
 *
 * Exit codes (CLI convention):
 *   0 = HEALTHY
 *   2 = DEGRADED or UNHEALTHY (needs operator attention)
 *   1 = unexpected error (e.g. invalid configuration)
 */

import { loadConfig } from '../config/load.js';
import {
  healthReportExitCode,
  runHealthcheck,
  type HealthReport,
} from '../ops/healthcheck.js';
import type { CommandHandler } from './context.js';

const USAGE = `bot healthcheck — READ-ONLY deployment health check (local only)

Usage: bot healthcheck [options]

Checks (never contacts NDAX, never mutates state):
  state-recovery    durable state parses, is consistent, and has no unresolved items
  mutation-lock     the state mutation lock is absent
  engine-heartbeat  the engine heartbeat exists and is fresh
  equity-history    the equity curve exists and has recent samples
  dashboard         the local dashboard's /api/healthz responds

Options:
  --json                       machine-readable output
  --require-engine             missing/stale heartbeat is FAIL (not WARN)
  --require-dashboard          unreachable dashboard is FAIL (not WARN)
  --no-dashboard               skip the dashboard probe
  --dashboard-url <url>        probe this base URL instead of loopback
  --max-heartbeat-age-ms <n>   heartbeat staleness threshold (default: 5x evaluate interval, min 120s)
  --help                       show this help

Exit codes: 0 healthy, 2 degraded/unhealthy, 1 error.
`;

interface ParsedArgs {
  json: boolean;
  requireEngine: boolean;
  requireDashboard: boolean;
  dashboardUrl?: string | null;
  heartbeatMaxAgeMs?: number;
}

function parseArgs(args: string[]): ParsedArgs | { error: string } {
  const parsed: ParsedArgs = {
    json: false,
    requireEngine: false,
    requireDashboard: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--require-engine') {
      parsed.requireEngine = true;
    } else if (arg === '--require-dashboard') {
      parsed.requireDashboard = true;
    } else if (arg === '--no-dashboard') {
      parsed.dashboardUrl = null;
    } else if (arg === '--dashboard-url') {
      const value = args[++i];
      if (!value) return { error: 'missing value for --dashboard-url' };
      parsed.dashboardUrl = value;
    } else if (arg === '--max-heartbeat-age-ms') {
      const value = args[++i];
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return { error: `--max-heartbeat-age-ms must be a positive integer (got "${value}")` };
      }
      parsed.heartbeatMaxAgeMs = n;
    } else {
      return { error: `unknown flag "${arg}"` };
    }
  }
  return parsed;
}

function printReport(report: HealthReport): void {
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const check of report.checks) counts[check.status] += 1;
  // eslint-disable-next-line no-console
  console.log(
    `Healthcheck: ${report.status} ` +
      `(${counts.PASS} pass, ${counts.WARN} warn, ${counts.FAIL} fail)`,
  );
  for (const check of report.checks) {
    // eslint-disable-next-line no-console
    console.log(`  [${check.status}] ${check.name}: ${check.detail}`);
  }
}

export const healthcheckCommand: CommandHandler = async (
  args,
  { logger },
): Promise<number> => {
  if (args.includes('--help') || args.includes('-h')) {
    // eslint-disable-next-line no-console
    console.log(USAGE);
    return 0;
  }

  const parsed = parseArgs(args);
  if ('error' in parsed) {
    // eslint-disable-next-line no-console
    console.error('Argument error: ' + parsed.error + '\n');
    // eslint-disable-next-line no-console
    console.log(USAGE);
    return 1;
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + message);
    return 1;
  }

  try {
    const report = await runHealthcheck({
      config: cfg,
      requireEngine: parsed.requireEngine,
      requireDashboard: parsed.requireDashboard,
      ...(parsed.dashboardUrl !== undefined ? { dashboardUrl: parsed.dashboardUrl } : {}),
      ...(parsed.heartbeatMaxAgeMs !== undefined
        ? { heartbeatMaxAgeMs: parsed.heartbeatMaxAgeMs }
        : {}),
    });

    if (parsed.json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
    return healthReportExitCode(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'healthcheck failed');
    // eslint-disable-next-line no-console
    console.error('Healthcheck failed: ' + message);
    return 1;
  }
};
