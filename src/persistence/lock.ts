/**
 * Single state-directory mutation lock (Persistence & Restart Recovery).
 *
 * All mutating operations across paper / live-managed / order-ledger /
 * manual-intents use the SAME directory lock. The lock protects the WHOLE
 * mutation transaction (load → validate → mutate → validate → atomic save →
 * release), not just the final write.
 *
 * The lock is acquired via exclusive creation (`open('wx')`). If the lock already
 * exists, the mutation is REFUSED (fail closed). The system NEVER inspects the
 * lock's PID to decide whether it is stale, NEVER auto-deletes or auto-steals a
 * lock, and NEVER auto-recovers. Malformed lock metadata also means refusal.
 * Removal is an explicit, documented manual recovery procedure only.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { StateLockedError } from './types.js';

export interface LockMetadata {
  pid: number;
  createdAtMs: number;
}

/** Lock paths held by THIS process (reentrancy guard). Cross-process remains exclusive. */
const heldByProcess = new Set<string>();

/** Derive the lock path from a state file path: its parent directory. */
export function lockPathFor(filePath: string): string {
  return `${dirname(filePath)}/.mutation.lock`;
}

/**
 * Run `fn` while holding the state-directory mutation lock for `dir`.
 * The lock is always released (on success OR failure).
 *
 * Reentrant within this process: a nested `withStateDirLock` for the same
 * directory (e.g. a store's `save()` called inside a `commitProven` transaction)
 * is allowed and does not re-acquire the lock. Cross-process, the lock remains
 * mutually exclusive via the lock file.
 *
 * @throws StateLockedError if the lock is held (by another process) / malformed.
 */
export function withStateDirLock<T>(dir: string, fn: () => T): T {
  const lockPath = `${dir}/.mutation.lock`;
  if (heldByProcess.has(lockPath)) {
    // Already held by this process: run reentrantly without re-acquiring.
    return fn();
  }
  mkdirSync(dir, { recursive: true });

  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch {
    throw new StateLockedError(
      `state mutation lock is held (${lockPath}); refusing to mutate. ` +
        'If no mutator is running, delete the lock file manually (documented recovery step).',
    );
  }

  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() } satisfies LockMetadata));
  } catch {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    throw new StateLockedError(`could not write lock metadata (${lockPath}); refusing to mutate`);
  }
  try {
    closeSync(fd);
  } catch {
    /* ignore */
  }

  heldByProcess.add(lockPath);
  try {
    return fn();
  } finally {
    heldByProcess.delete(lockPath);
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* ignore: lock already gone */
    }
  }
}

/** True if a lock file exists for the directory (used to classify a HALT). */
export function isLockHeld(dir: string): boolean {
  try {
    readFileSync(`${dir}/.mutation.lock`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
