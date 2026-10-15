import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { botConfigSchema } from '../../../src/config/schema.js';
import { buildEngineDeps } from '../../../src/engine/buildEngine.js';
import { readEngineStatus } from '../../../src/monitoring/engineHeartbeat.js';
import { readEquityHistory } from '../../../src/persistence/equityHistory.js';
import { statePath } from '../../helpers/state.js';
import type { Logger } from '../../../src/logging/logger.js';

const silence: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silence,
};

describe('buildEngineDeps — paper heartbeat wiring', () => {
  it('writes a paper heartbeat and equity sample when the engine emits status', () => {
    const dir = dirname(statePath('build-engine-heartbeat', 'x.json'));
    const cfg = botConfigSchema.parse({
      stateDir: dir,
      paperStateFile: join(dir, 'paper-state.json'),
      liveManagedStateFile: join(dir, 'live-managed-state.json'),
      orderLedgerFile: join(dir, 'order-ledger.json'),
      manualIntentFile: join(dir, 'manual-intents.json'),
      engineStatusFile: join(dir, 'engine-status.json'),
      equityHistoryFile: join(dir, 'equity-history.jsonl'),
    });

    try {
      const deps = buildEngineDeps(cfg, silence);
      expect(typeof deps.onStatus).toBe('function');

      deps.onStatus!({
        running: true,
        startedAtMs: 1,
        lastEvaluateMs: 2,
        lastEvaluateError: null,
        symbols: ['BTC/CAD'],
        ordersPlaced: 0,
        equity: '10000.00000000',
        cash: { CAD: '10000.00000000' },
      });

      const heartbeat = readEngineStatus(join(dir, 'engine-status.json'));
      expect(heartbeat.status).toBe('OK');
      if (heartbeat.status === 'OK') {
        expect(heartbeat.data.kind).toBe('paper');
        expect((heartbeat.data.status as { running?: boolean }).running).toBe(true);
      }

      const equity = readEquityHistory(join(dir, 'equity-history.jsonl'));
      expect(equity.status).toBe('OK');
      if (equity.status === 'OK') {
        expect(equity.samples).toHaveLength(1);
        expect(equity.samples[0]!.equity).toBe('10000.00000000');
        expect(equity.samples[0]!.cash).toEqual({ CAD: '10000.00000000' });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
