import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Return a unique, isolated state-file path for a test module. Each call to
 * `statePath` creates a fresh temp directory, so the state-directory mutation
 * lock (which is per-directory) is never contended across test modules.
 */
export function statePath(prefix: string, name: string): string {
  return join(mkdtempSync(join(tmpdir(), `retrac-${prefix}-`)), name);
}
