import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { appendEquitySample, readEquityHistory } from '../../../src/persistence/equityHistory.js';
import { statePath } from '../../helpers/state.js';

describe('equity history (append-only JSONL)', () => {
  it('appends and reads samples (tail, bounded)', () => {
    const path = statePath('equity', 'history.jsonl');
    for (let i = 0; i < 5; i++) {
      appendEquitySample(path, { atMs: 1000 + i, equity: String(100 + i), cash: { CAD: String(100 + i) } });
    }
    const r = readEquityHistory(path, 3);
    expect(r.status).toBe('OK');
    if (r.status === 'OK') {
      expect(r.samples).toHaveLength(3);
      expect(r.samples[0]!.equity).toBe('102');
      expect(r.samples[2]!.equity).toBe('104');
    }
  });

  it('reports MISSING for an absent file', () => {
    expect(readEquityHistory(statePath('equity-missing', 'x.jsonl')).status).toBe('MISSING');
  });

  it('skips malformed lines but keeps valid ones', () => {
    const path = statePath('equity-malformed', 'history.jsonl');
    appendEquitySample(path, { atMs: 1, equity: '10', cash: {} });
    writeFileSync(path, `${JSON.stringify({ atMs: 1, equity: '10', cash: {} })}\nnot-json\n${JSON.stringify({ atMs: 2, equity: '11', cash: {} })}\n`);
    const r = readEquityHistory(path);
    expect(r.status).toBe('OK');
    if (r.status === 'OK') {
      expect(r.samples).toHaveLength(2);
      expect(r.samples[1]!.equity).toBe('11');
    }
  });
});
