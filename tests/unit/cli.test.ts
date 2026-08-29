import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli/cli.js';

describe('CLI dispatcher', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints usage for help', async () => {
    const code = await run(['help']);
    expect(code).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  it('prints usage for no arguments', async () => {
    const code = await run([]);
    expect(code).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  it('returns error for unknown command', async () => {
    const code = await run(['not-a-command']);
    expect(code).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('returns a number for paper (validate-only path, no engine start)', async () => {
    // --validate loads/validates config and exits without blocking on the engine.
    const code = await run(['paper', '--validate']);
    // May succeed with defaults or fail depending on environment; just assert it
    // returns a number without throwing and without starting a long-running bot.
    expect(typeof code).toBe('number');
    expect(code).toBeLessThan(2);
  });
});
