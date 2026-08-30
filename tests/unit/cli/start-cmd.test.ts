import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCommand } from '../../../src/cli/start-cmd.js';

/**
 * `bot start` live-confirmation tests. They run in valid-but-unarmed mode: even
 * with TRADING_MODE=live + REAL_FUNDS_AT_RISK=true + --confirm-live, the NDAX
 * adapter keeps supportsOrderPlacement=false, so live start always refuses and
 * NO engine runs and NO order is ever placed.
 */
describe('bot start — live confirmation gates', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('paper mode with --validate exits 0 without starting an engine', async () => {
    vi.stubEnv('TRADING_MODE', 'paper');
    const code = await startCommand(['--validate']);
    expect(code).toBe(0);
  });

  it('refuses live mode without the explicit --confirm-live flag', async () => {
    vi.stubEnv('TRADING_MODE', 'live');
    vi.stubEnv('REAL_FUNDS_AT_RISK', 'true');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await startCommand([]);
    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join(' ')).toContain('--confirm-live');
  });

  it('requires REAL_FUNDS_AT_RISK=true acknowledgement, even with --confirm-live', async () => {
    vi.stubEnv('TRADING_MODE', 'live');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await startCommand(['--confirm-live']);
    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join(' ')).toMatch(/REAL_FUNDS_AT_RISK/);
  });

  it('refuses live start while the exchange adapter reports supportsOrderPlacement=false', async () => {
    vi.stubEnv('TRADING_MODE', 'live');
    vi.stubEnv('REAL_FUNDS_AT_RISK', 'true');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await startCommand(['--confirm-live']);
    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join(' ')).toContain('supportsOrderPlacement');
  });

  it('refuses when the kill switch is active', async () => {
    vi.stubEnv('KILL_SWITCH', 'true');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await startCommand([]);
    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join(' ')).toContain('KILL_SWITCH');
  });
});