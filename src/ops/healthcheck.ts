/**
 * Read-only operational health check.
 *
 * `bot healthcheck` answers "is this deployment healthy right now?" without
 * mutating state, contacting the exchange, or placing/cancelling orders. It
 * composes the same fail-closed readers the engine/dashboard use:
 *
 *   - state recovery (`recoverState`) — corruption, unresolved orders/intents,
 *     orphan reservations, unexpected state loss;
 *   - the state-directory mutation lock (must normally be absent);
 *   - the engine heartbeat (freshness, halted/running flags);
 *   - the append-only equity curve (present and recent);
 *   - the local dashboard's `/api/healthz` liveness endpoint.
 *
 * Dashboard `/api/healthz` is deliberately local-only: it confirms the process
 * is listening and does NOT trigger the NDAX `/api/health` read. Exchange
 * connectivity remains an explicit dashboard/`verify:ndax` action.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig } from '../config/schema.js';
import { ManualIntentStore } from '../manual/ManualIntentStore.js';
import {
  ManagedStateStore,
  OrderStore,
  PaperStateStore,
  StateInitMarker,
  readEquityHistory,
  recoverState,
} from '../persistence/index.js';
import { readEngineStatus } from '../monitoring/index.js';

export type HealthCheckStatus = 'PASS' | 'WARN' | 'FAIL';
export type HealthReportStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

export interface HealthCheckEntry {
  name: string;
  status: HealthCheckStatus;
  detail: string;
}

export interface HealthReport {
  status: HealthReportStatus;
  generatedAtMs: number;
  checks: HealthCheckEntry[];
}

export interface HealthcheckOptions {
  config: BotConfig;
  /** Wall clock override (tests). */
  nowMs?: number;
  /** A heartbeat older than this is stale. Defaults to `defaultHeartbeatMaxAgeMs`. */
  heartbeatMaxAgeMs?: number;
  /**
   * Dashboard base URL to probe. `undefined` probes the configured loopback
   * dashboard; `null` disables the dashboard check.
   */
  dashboardUrl?: string | null;
  /** Treat a missing/stale engine heartbeat as FAIL instead of WARN. */
  requireEngine?: boolean;
  /** Treat an unreachable dashboard as FAIL instead of WARN. */
  requireDashboard?: boolean;
  /** Fetch implementation injection (tests). */
  fetchImpl?: typeof fetch;
  /** Dashboard probe timeout. Defaults to 2000ms. */
  dashboardTimeoutMs?: number;
}

/** Default heartbeat staleness threshold: five evaluate intervals, min 2 minutes. */
export function defaultHeartbeatMaxAgeMs(config: BotConfig): number {
  const intervalMs = Math.max(1, config.evaluateIntervalSeconds) * 1000;
  return Math.max(intervalMs * 5, 120_000);
}

function recoveryCheck(config: BotConfig): HealthCheckEntry {
  const report = recoverState({
    paper: new PaperStateStore(config.paperStateFile),
    live: new ManagedStateStore(config.liveManagedStateFile),
    orders: new OrderStore(config.orderLedgerFile),
    manualIntents: new ManualIntentStore(config.manualIntentFile),
    initMarker: new StateInitMarker(join(config.stateDir, '.init.json')),
  });

  const detail =
    report.reasons.join('; ') +
    (report.unresolvedOrders.length > 0
      ? `; unresolved orders: ${report.unresolvedOrders.join(', ')}`
      : '') +
    (report.unresolvedReservations.length > 0
      ? `; unresolved reservations: ${report.unresolvedReservations.join(', ')}`
      : '') +
    (report.unresolvedIntents.length > 0
      ? `; unresolved intents: ${report.unresolvedIntents.join(', ')}`
      : '') +
    (report.crossFileIssues.length > 0
      ? `; cross-file issues: ${report.crossFileIssues.join('; ')}`
      : '');

  if (report.status === 'HALTED') {
    return { name: 'state-recovery', status: 'FAIL', detail };
  }
  if (report.status === 'RECONCILIATION_REQUIRED') {
    return {
      name: 'state-recovery',
      status: 'WARN',
      detail: `${detail}; run \`bot reconcile\` and follow the operator recovery docs`,
    };
  }
  return { name: 'state-recovery', status: 'PASS', detail };
}

function lockCheck(config: BotConfig): HealthCheckEntry {
  const lockPath = join(config.stateDir, '.mutation.lock');
  if (!existsSync(lockPath)) {
    return { name: 'mutation-lock', status: 'PASS', detail: 'absent' };
  }
  return {
    name: 'mutation-lock',
    status: 'WARN',
    detail:
      'present: a mutation may be in progress. If no bot process is running, ' +
      'follow the stale-lock procedure in docs/CREATED_ORDER_RECOVERY.md (never delete it blindly).',
  };
}

function engineCheck(
  config: BotConfig,
  nowMs: number,
  maxAgeMs: number,
  requireEngine: boolean,
): HealthCheckEntry {
  const status = requireEngine ? 'FAIL' : 'WARN';
  const r = readEngineStatus(config.engineStatusFile);
  if (r.status === 'MISSING') {
    return {
      name: 'engine-heartbeat',
      status,
      detail: `missing (${config.engineStatusFile}); the engine is not running or has never started`,
    };
  }
  if (r.status === 'CORRUPT') {
    return { name: 'engine-heartbeat', status: 'FAIL', detail: `corrupt: ${r.reason}` };
  }

  const ageMs = nowMs - r.data.updatedAtMs;
  const s = r.data.status as Record<string, unknown>;
  const halted = s.halted === true;
  const halt = (s.halt ?? null) as { reason?: unknown } | null;
  const haltReason =
    halted && halt !== null && typeof halt.reason === 'string' ? halt.reason : null;
  const running = typeof s.running === 'boolean' ? s.running : null;
  const stale = ageMs > maxAgeMs;
  const clockSkew = ageMs < -60_000;
  const base =
    `kind=${r.data.kind} age=${Math.round(ageMs / 1000)}s` +
    (running === null ? '' : ` running=${running}`) +
    (halted ? ' halted=true' : '');

  if (halted) {
    return {
      name: 'engine-heartbeat',
      status: 'FAIL',
      detail: `${base}${haltReason ? `; halt reason: ${haltReason}` : ''}`,
    };
  }
  if (stale || clockSkew || running === false) {
    const detail = clockSkew
      ? `${base}; heartbeat timestamp is in the future (clock skew?)`
      : stale
        ? `${base}; stale (threshold ${Math.round(maxAgeMs / 1000)}s)`
        : `${base}; engine reports it is not running`;
    return { name: 'engine-heartbeat', status, detail };
  }
  return { name: 'engine-heartbeat', status: 'PASS', detail: base };
}

function equityCheck(config: BotConfig, nowMs: number, maxAgeMs: number): HealthCheckEntry {
  const r = readEquityHistory(config.equityHistoryFile, 1);
  if (r.status === 'MISSING') {
    return {
      name: 'equity-history',
      status: 'WARN',
      detail: `missing (${config.equityHistoryFile}); no equity samples yet`,
    };
  }
  if (r.status === 'ERROR') {
    return { name: 'equity-history', status: 'FAIL', detail: `unreadable: ${r.reason}` };
  }
  if (r.samples.length === 0) {
    return {
      name: 'equity-history',
      status: 'WARN',
      detail: 'present but contains no valid samples',
    };
  }
  const latest = r.samples[r.samples.length - 1]!;
  const ageMs = nowMs - latest.atMs;
  const detail = `latest equity=${latest.equity} age=${Math.round(ageMs / 1000)}s`;
  if (ageMs > maxAgeMs) {
    return {
      name: 'equity-history',
      status: 'WARN',
      detail: `${detail}; stale (threshold ${Math.round(maxAgeMs / 1000)}s)`,
    };
  }
  return { name: 'equity-history', status: 'PASS', detail };
}

async function dashboardCheck(
  config: BotConfig,
  options: HealthcheckOptions,
): Promise<HealthCheckEntry> {
  const requireDashboard = options.requireDashboard === true;
  if (options.dashboardUrl === null) {
    return { name: 'dashboard', status: 'PASS', detail: 'check disabled' };
  }
  const configuredHost =
    typeof config.dashboardHost === 'string' && config.dashboardHost !== ''
      ? config.dashboardHost
      : '127.0.0.1';
  const probeHost =
    configuredHost === '0.0.0.0' || configuredHost === '::' || configuredHost === ''
      ? '127.0.0.1'
      : configuredHost;
  const urlHost =
    probeHost.includes(':') && !probeHost.startsWith('[') ? `[${probeHost}]` : probeHost;
  const base = options.dashboardUrl ?? `http://${urlHost}:${config.dashboardPort}`;
  const url = `${base.replace(/\/+$/, '')}/api/healthz`;
  const timeoutMs = options.dashboardTimeoutMs ?? 2000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const failureStatus: HealthCheckStatus = requireDashboard ? 'FAIL' : 'WARN';

  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        name: 'dashboard',
        status: failureStatus,
        detail: `${url} returned HTTP ${res.status}`,
      };
    }
    return { name: 'dashboard', status: 'PASS', detail: `${url} reachable` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'dashboard',
      status: failureStatus,
      detail: `${url} unreachable: ${message}`,
    };
  }
}

/** Run every check. Never throws for a failed check (only for a programming error). */
export async function runHealthcheck(options: HealthcheckOptions): Promise<HealthReport> {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.heartbeatMaxAgeMs ?? defaultHeartbeatMaxAgeMs(options.config);
  const checks: HealthCheckEntry[] = [
    recoveryCheck(options.config),
    lockCheck(options.config),
    engineCheck(options.config, nowMs, maxAgeMs, options.requireEngine === true),
    equityCheck(options.config, nowMs, maxAgeMs),
    await dashboardCheck(options.config, options),
  ];

  const status: HealthReportStatus = checks.some((c) => c.status === 'FAIL')
    ? 'UNHEALTHY'
    : checks.some((c) => c.status === 'WARN')
      ? 'DEGRADED'
      : 'HEALTHY';

  return { status, generatedAtMs: nowMs, checks };
}

/** CLI exit code convention: 0 healthy, 2 degraded/unhealthy, 1 error. */
export function healthReportExitCode(report: HealthReport): number {
  return report.status === 'HEALTHY' ? 0 : 2;
}
