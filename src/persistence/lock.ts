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
import { dirname, resolve as pathResolve } from 'node:path';
import { StateLockedError } from './types.js';

export interface LockMetadata {
  pid: number;
  createdAtMs: number;
}

/** Lock paths held by THIS process (reentrancy guard). Cross-process remains exclusive. */
const heldByProcess = new Set<string>();

/**
 * Canonicalize a state-directory path so ALL equivalent textual forms collapse to
 * a single lock identity. This is essential: `withStateDirLock(cfg.stateDir)`
 * (e.g. `".state/"`) and a store's `withStateDirLock(dirname(filePath))` (e.g.
 * `".state"`) both refer to the SAME directory but, if keyed by raw strings,
 * would produce different lock paths (`".state//.mutation.lock"` vs
 * `".state/.mutation.lock"`) that point at the same physical file. That breaks
 * the process-local `heldByProcess` reentrancy guard, causing a nested call to
 * see `EEXIST` on its own lock (a self-deadlock).
 *
 * We normalize to an ABSOLUTE path so relative/absolute and trailing-slash
 * forms are identical, and two genuinely distinct directories never collide.
 */
function canonicalLockDir(dir: string): string {
  return pathResolve(dir);
}

/** Derive the lock path from a state file path: its parent directory's canonical lock. */
export function lockPathFor(filePath: string): string {
  return `${canonicalLockDir(dirname(filePath))}/.mutation.lock`;
}

/**
 * Acquire the state-directory lock file for `lockPath` (atomic exclusive
 * create). On success the canonical path is added to the process reentrancy set.
 * Cross-process exclusion is provided by the filesystem `open('wx')`; no PID
 * inspection, stale-lock stealing, or timeout takeover is ever performed.
 *
 * @throws StateLockedError if the lock already exists (held by another process)
 *         or its metadata cannot be written.
 */
function acquireStateDirLock(lockDir: string, lockPath: string): void {
  mkdirSync(lockDir, { recursive: true });

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
}

/** Release the lock file and the process reentrancy entry (idempotent). */
function releaseStateDirLock(lockPath: string): void {
  heldByProcess.delete(lockPath);
  try {
    rmSync(lockPath, { force: true });
  } catch {
    /* ignore: lock already gone */
  }
}

/**
 * Run `fn` while holding the state-directory mutation lock for `dir`.
 * The lock is always released (on success OR failure).
 *
 * Reentrant within this process: a nested `withStateDirLock` for the same
 * canonical directory (e.g. a store's `save()` called inside a `commitProven`
 * transaction) is allowed and does not re-acquire the lock. Cross-process, the
 * lock remains mutually exclusive via the lock file.
 *
 * @throws StateLockedError if the lock is held (by another process) / malformed.
 */
export function withStateDirLock<T>(dir: string, fn: () => T): T {
  const lockDir = canonicalLockDir(dir);
  const lockPath = `${lockDir}/.mutation.lock`;
  if (heldByProcess.has(lockPath)) {
    // Already held by this process: run reentrantly without re-acquiring.
    return fn();
  }
  acquireStateDirLock(lockDir, lockPath);
  try {
    return fn();
  } finally {
    releaseStateDirLock(lockPath);
  }
}

/**
 * ASYNC variant of {@link withStateDirLock}: it holds the SAME state-directory
 * `.mutation.lock` across `await` points, so a critical section that must span
 * asynchronous work (e.g. the LIVE guard → persist-CREATED → exchange
 * submission sequence) stays atomic against OTHER PROCESSES for its whole
 * duration. This is NOT a second lock: it shares the canonical lock path and the
 * process reentrancy set with the synchronous variant, so a nested synchronous
 * store `save()` inside the held async lock runs reentrantly (no self-deadlock),
 * and a separate process attempting the same directory fails closed with
 * `StateLockedError`.
 *
 * The lock is always released on success OR failure. A process that crashes
 * while holding it leaves the lock file in place; by design every subsequent
 * mutator fails closed until the documented manual lock removal — there is no
 * stale-lock stealing or timeout takeover.
 *
 * @throws StateLockedError if the lock is held (by another process) / malformed.
 */
export async function withStateDirLockAsync<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = canonicalLockDir(dir);
  const lockPath = `${lockDir}/.mutation.lock`;
  if (heldByProcess.has(lockPath)) {
    // Already held by this process: run reentrantly without re-acquiring.
    return fn();
  }
  acquireStateDirLock(lockDir, lockPath);
  try {
    return await fn();
  } finally {
    releaseStateDirLock(lockPath);
  }
}

/** True if a lock file exists for the directory (used to classify a HALT). */
export function isLockHeld(dir: string): boolean {
  try {
    readFileSync(`${canonicalLockDir(dir)}/.mutation.lock`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
