import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { writeEngineStatus, readEngineStatus } from '../../../src/monitoring/engineHeartbeat.js';
import { statePath } from '../../helpers/state.js';

describe('engine heartbeat status file', () => {
  it('round-trips a status record', () => {
    const path = statePath('heartbeat', 'engine-status.json');
    writeEngineStatus(path, { kind: 'live', updatedAtMs: 123, status: { running: true } });
    const r = readEngineStatus(path);
    expect(r.status).toBe('OK');
    if (r.status === 'OK') {
      expect(r.data.kind).toBe('live');
      expect(r.data.updatedAtMs).toBe(123);
      expect(r.data.status).toEqual({ running: true });
    }
  });

  it('reports MISSING when the file does not exist', () => {
    const path = statePath('heartbeat-missing', 'engine-status.json');
    expect(readEngineStatus(path).status).toBe('MISSING');
  });

  it('reports CORRUPT for malformed JSON and invalid shape (never invents)', () => {
    const bad = statePath('heartbeat-corrupt', 'engine-status.json');
    writeFileSync(bad, '{not json');
    expect(readEngineStatus(bad).status).toBe('CORRUPT');

    const badShape = statePath('heartbeat-shape', 'engine-status.json');
    writeFileSync(badShape, JSON.stringify({ kind: 'nope', updatedAtMs: 'x' }));
    expect(readEngineStatus(badShape).status).toBe('CORRUPT');
  });
});
