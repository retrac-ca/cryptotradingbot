import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../../../src/config/schema.js';
import {
  appendEquitySample,
  PaperStateStore,
  StateInitMarker,
} from '../../../src/persistence/index.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { writeEngineStatus } from '../../../src/monitoring/engineHeartbeat.js';
import {
  defaultHeartbeatMaxAgeMs,
  healthReportExitCode,
  runHealthcheck,
} from '../../../src/ops/healthcheck.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'retrac-health-'));
  dirs.push(dir);
  return dir;
}

function makeConfig(dir: string): BotConfig {
  return {
    stateDir: dir,
    paperStateFile: join(dir, 'paper-state.json'),
    liveManagedStateFile: join(dir, 'live-managed-state.json'),
    orderLedgerFile: join(dir, 'order-ledger.json'),
    manualIntentFile: join(dir, 'manual-intents.json'),
    engineStatusFile: join(dir, 'engine-status.json'),
    equityHistoryFile: join(dir, 'equity-history.jsonl'),
    evaluateIntervalSeconds: 60,
    dashboardPort: 8787,
  } as BotConfig;
}

function writeHealthyState(cfg: BotConfig, nowMs: number): void {
  new PaperStateStore(cfg.paperStateFile).save(Portfolio.empty().stateModel, []);
  new StateInitMarker(join(cfg.stateDir, '.init.json')).markInitialized('paper');
  writeEngineStatus(cfg.engineStatusFile, {
    kind: 'paper',
    updatedAtMs: nowMs,
    status: { running: true, halted: false, lastEvaluateMs: nowMs },
  });
  appendEquitySample(cfg.equityHistoryFile, {
    atMs: nowMs,
    equity: '10000.00000000',
    cash: { CAD: '10000.00000000' },
  });
}

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })) as unknown as typeof fetch;
}

describe('runHealthcheck', () => {
  it('reports HEALTHY when state, heartbeat, equity curve, and dashboard are healthy', async () => {
    const dir = makeDir();
    const cfg = makeConfig(dir);
    const nowMs = 1_000_000;
    writeHealthyState(cfg, nowMs);

    const report = await runHealthcheck({ config: cfg, nowMs, fetchImpl: okFetch() });

    expect(report.status).toBe('HEALTHY');
    expect(report.checks.map((c) => c.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    expect(healthReportExitCode(report)).toBe(0);
    expect(report.checks.find((c) => c.name === 'engine-heartbeat')?.detail).toContain('age=0s');
  });

  it('flags corrupt durable state as UNHEALTHY', async () => {
    const dir = makeDir();
    const cfg = makeConfig(dir);
    writeFileSync(cfg.paperStateFile, 'not-json', 'utf8');

    const report = await runHealthcheck({
      config: cfg,
      nowMs: 1_000_000,
      fetchImpl: okFetch(),
    });

    expect(report.status).toBe('UNHEALTHY');
    expect(report.checks.find((c) => c.name === 'state-recovery')?.status).toBe('FAIL');
    expect(healthReportExitCode(report)).toBe(2);
  });

  it('warns on a missing heartbeat by default and fails when the engine is required', async () => {
    const dir = makeDir();
    const cfg = makeConfig(dir);
    writeHealthyState(cfg, 1_000_000);
    rmSync(cfg.engineStatusFile);

    const optional = await runHealthcheck({
      config: cfg,
      nowMs: 1_000_000,
      fetchImpl: okFetch(),
    });
    expect(optional.status).toBe('DEGRADED');
    expect(optional.checks.find((c) => c.name === 'engine-heartbeat')?.status).toBe('WARN');

    const required = await runHealthcheck({
      config: cfg,
      nowMs: 1_000_000,
      requireEngine: true,
      fetchImpl: okFetch(),
    });
    expect(required.status).toBe('UNHEALTHY');
    expect(required.checks.find((c) => c.name === 'engine-heartbeat')?.status).toBe('FAIL');
  });

  it('fails on a halted heartbeat and warns on a stale one', async () => {
    const dir = makeDir();
    const cfg = makeConfig(dir);
    writeHealthyState(cfg, 1_000_000);
    writeEngineStatus(cfg.engineStatusFile, {
      kind: 'live',
      updatedAtMs: 1_000_000,
      status: { running: true, halted: true, halt: { reason: 'UNKNOWN order' } },
    });

    const halted = await runHealthcheck({
      config: cfg,
      nowMs: 1_000_000,
      fetchImpl: okFetch(),
    });
    expect(halted.status).toBe('UNHEALTHY');
    const haltedCheck = halted.checks.find((c) => c.name === 'engine-heartbeat');
    expect(haltedCheck?.status).toBe('FAIL');
    expect(haltedCheck?.detail).toContain('UNKNOWN order');

    writeEngineStatus(cfg.engineStatusFile, {
      kind: 'paper',
      updatedAtMs: 1_000_000,
      status: { running: true, halted: false },
    });
    const stale = await runHealthcheck({
      config: cfg,
      nowMs: 1_000_000 + 10 * 60_000,
      heartbeatMaxAgeMs: 60_000,
      fetchImpl: okFetch(),
    });
    expect(stale.status).toBe('DEGRADED');
    expect(stale.checks.find((c) => c.name === 'engine-heartbeat')?.detail).toContain('stale');
  });

  it('warns on an unreachable dashboard by default and fails when required', async () => {
    const dir = makeDir();
    const cfg = makeConfig(dir);
    writeHealthyState(cfg, 1_000_000);
    const badFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const optional = await runHealthcheck({
      config: cfg,
      nowMs: 1_000_000,
      fetchImpl: badFetch,
    });
    expect(optional.status).toBe('DEGRADED');
    expect(optional.checks.find((c) => c.name === 'dashboard')?.status).toBe('WARN');

    const required = await runHealthcheck({
      config: cfg,
      nowMs: 1_000_000,
      requireDashboard: true,
      fetchImpl: badFetch,
    });
    expect(required.status).toBe('UNHEALTHY');
    expect(required.checks.find((c) => c.name === 'dashboard')?.status).toBe('FAIL');
  });

  it('skips the dashboard probe when disabled', async () => {
    const dir = makeDir();
    const cfg = makeConfig(dir);
    writeHealthyState(cfg, 1_000_000);
    const badFetch = vi.fn(async () => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;

    const report = await runHealthcheck({
      config: cfg,
      nowMs: 1_000_000,
      dashboardUrl: null,
      fetchImpl: badFetch,
    });

    expect(report.status).toBe('HEALTHY');
    expect(report.checks.find((c) => c.name === 'dashboard')?.detail).toBe('check disabled');
    expect(badFetch).not.toHaveBeenCalled();
  });
});

describe('defaultHeartbeatMaxAgeMs', () => {
  it('uses five evaluate intervals with a two-minute floor', () => {
    expect(defaultHeartbeatMaxAgeMs({ evaluateIntervalSeconds: 60 } as BotConfig)).toBe(300_000);
    expect(defaultHeartbeatMaxAgeMs({ evaluateIntervalSeconds: 10 } as BotConfig)).toBe(120_000);
  });
});
