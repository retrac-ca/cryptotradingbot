/**
 * State-directory mutation lock — path-identity regression tests.
 *
 * The lock must canonicalize its directory so ALL equivalent textual forms
 * (trailing slash, `/.`, repeated slashes) resolve to a SINGLE lock identity.
 * Prior to the fix, `withStateDirLock(cfg.stateDir)` produced `.state//.mutation.lock`
 * while a store's `withStateDirLock(dirname(filePath))` produced
 * `.state/.mutation.lock` — the SAME physical file but different raw strings —
 * which broke the process-local `heldByProcess` reentrancy guard and caused a
 * self-deadlock (EEXIST on the caller's own lock).
 *
 * These tests use a temporary directory (never the real `.state`).
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withStateDirLock, isLockHeld, lockPathFor, StateLockedError } from '../../../src/persistence/index.js';

const bases: string[] = [];

function makeBase(): string {
  const base = join(mkdtempSync(join(tmpdir(), 'retrac-lock-')), 'state');
  bases.push(base);
  return base;
}

afterEach(() => {
  for (const b of bases) {
    rmSync(b + '/.mutation.lock', { force: true });
    rmSync(b, { recursive: true, force: true });
  }
  bases.length = 0;
});

describe('State-directory mutation lock — path identity canonicalization', () => {
  it('A: trailing-slash reentrancy (outer with slash, inner without) succeeds', () => {
    const base = makeBase();
    // cfg.stateDir-style (with trailing slash) vs store dirname-style (without).
    const result = withStateDirLock(`${base}/`, () =>
      withStateDirLock(base, () => {
        expect(isLockHeld(base)).toBe(true);
        return 42;
      }),
    );
    expect(result).toBe(42);
    // Cleanup happens after the OUTER completes.
    expect(isLockHeld(base)).toBe(false);
  });

  it('B: reverse direction (outer without slash, inner with slash) succeeds', () => {
    const base = makeBase();
    const result = withStateDirLock(base, () =>
      withStateDirLock(`${base}/`, () => { /* nested reentrant */ return 'ok'; }),
    );
    expect(result).toBe('ok');
    expect(isLockHeld(base)).toBe(false);
  });

  it('C: equivalent normalized forms ("./state" vs "state", "./state/" vs "state") are the same directory', () => {
    const base = makeBase();
    // Simulate relative-equivalent forms via `/.` and repeated slashes.
    const a = `${base}/./`;
    const b = `${base}/`;
    const result = withStateDirLock(a, () =>
      withStateDirLock(b, () => {
        // Same physical directory behind both spellings => reentrant.
        return lockPathFor(`${base}/live.json`);
      }),
    );
    // lockPathFor on the same directory yields the same lock path regardless of spelling.
    expect(result).toBe(lockPathFor(`${base}/order.json`));
    expect(isLockHeld(base)).toBe(false);
  });

  it('D: a genuinely externally-acquired lock (another process style) still fails closed', () => {
    const base = makeBase();
    // Simulate a separate process holding the lock: pre-create the file.
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, '.mutation.lock'), JSON.stringify({ pid: 999999, createdAtMs: Date.now() }));
    expect(() => withStateDirLock(base, () => 'should-not-run')).toThrow(StateLockedError);
    expect(isLockHeld(base)).toBe(true); // the external lock is untouched
  });

  it('E: lock is absent after a successful outer completion', () => {
    const base = makeBase();
    withStateDirLock(base, () => {});
    expect(existsSync(join(base, '.mutation.lock'))).toBe(false);
    expect(isLockHeld(base)).toBe(false);
  });

  it('F: an exception in the callback still removes the lock and propagates', () => {
    const base = makeBase();
    expect(() =>
      withStateDirLock(base, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(join(base, '.mutation.lock'))).toBe(false);
    expect(isLockHeld(base)).toBe(false);
  });

  it('G: reentrancy does not prematurely release the outer lock', () => {
    const base = makeBase();
    let nestedReturnedWhileOuter = false;
    withStateDirLock(`${base}/`, () => {
      withStateDirLock(base, () => {
        // Inner returns; the outer callback is STILL executing, so the physical
        // lock must still be present.
        return undefined;
      });
      nestedReturnedWhileOuter = true;
      expect(isLockHeld(base)).toBe(true); // outer lock still held
    });
    expect(nestedReturnedWhileOuter).toBe(true);
    expect(isLockHeld(base)).toBe(false); // released only after outer completes
  });

  it('H: distinct directories do NOT share a lock', () => {
    const baseA = makeBase();
    const baseB = join(baseA, '..', 'second'); // a genuinely different sibling dir
    bases.push(baseB);
    // Hold A, then a separate acquisition of B must succeed (different lock file).
    withStateDirLock(baseA, () => {
      const r = withStateDirLock(baseB, () => 'b');
      expect(r).toBe('b');
    });
    expect(isLockHeld(baseA)).toBe(false);
    expect(isLockHeld(baseB)).toBe(false);
  });
});
