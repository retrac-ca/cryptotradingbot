/**
 * State-directory backup (read-only with respect to bot state).
 *
 * `bot backup-state` takes a point-in-time copy of every durable state file
 * under `STATE_DIR` into a timestamped sibling directory, then prunes old
 * snapshots. It is deliberately a LOCAL filesystem operation:
 *
 *   - it never contacts the exchange and never submits/cancels an order;
 *   - it never acquires the mutation lock (backups must not block trading);
 *   - it never modifies, truncates, or deletes a state file;
 *   - it skips `.mutation.lock` and `*.tmp` (transient files);
 *   - it writes a manifest and prunes ONLY snapshots it recognizes as its own.
 *
 * Envelope writes are atomic (temp + rename), so every copied file is internally
 * consistent. A snapshot can still span two engine cycles across files; that is
 * acceptable for disaster recovery and is recorded in the manifest.
 */

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface StateBackupOptions {
  /** Source state directory (must exist). */
  stateDir: string;
  /** Destination directory (created if needed). Must not be inside `stateDir`. */
  backupDir: string;
  /** Number of snapshots to retain. Defaults to 14. */
  keep?: number;
  /** Wall clock override (tests). */
  nowMs?: number;
}

export interface StateBackupResult {
  backupDir: string;
  backupPath: string;
  files: string[];
  skipped: string[];
  pruned: string[];
}

/** Default sibling backup directory: `.state/` -> `.state-backups/`. */
export function defaultBackupDir(stateDir: string): string {
  const abs = resolve(stateDir);
  return join(dirname(abs), `${basename(abs)}-backups`);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** ISO timestamp safe for a directory name (no colons). */
function timestampFor(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, '-');
}

/**
 * Create one snapshot. Throws on invalid configuration or an I/O failure; a
 * failed copy removes its partial temp directory and leaves prior snapshots
 * untouched.
 */
export function backupState(options: StateBackupOptions): StateBackupResult {
  const stateDir = resolve(options.stateDir);
  const backupDir = resolve(options.backupDir);
  const keep = options.keep ?? 14;
  const nowMs = options.nowMs ?? Date.now();

  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error('--keep must be a positive integer');
  }
  if (!existsSync(stateDir) || !statSync(stateDir).isDirectory()) {
    throw new Error(`state directory does not exist or is not a directory: ${options.stateDir}`);
  }
  if (isInside(stateDir, backupDir)) {
    throw new Error(
      `backup directory must be outside STATE_DIR (STATE_DIR=${stateDir}, backup=${backupDir})`,
    );
  }

  const stamp = timestampFor(nowMs);
  const finalPath = join(backupDir, `state-${stamp}`);
  const tempPath = join(backupDir, `.tmp-state-${stamp}-${process.pid}`);
  if (existsSync(finalPath)) {
    throw new Error(`backup already exists for this timestamp: ${finalPath}`);
  }

  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  mkdirSync(tempPath, { recursive: true, mode: 0o700 });

  const files: string[] = [];
  const skipped: string[] = [];
  try {
    for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
      const source = join(stateDir, entry.name);
      if (entry.name === '.mutation.lock' || entry.name.endsWith('.tmp')) {
        skipped.push(entry.name);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push(entry.name);
        continue;
      }
      copyFileSync(source, join(tempPath, entry.name), constants.COPYFILE_EXCL);
      files.push(entry.name);
    }

    const manifest = {
      format: 1,
      createdAtMs: nowMs,
      stateDir,
      files: files.map((name) => ({ name, size: statSync(join(tempPath, name)).size })),
      skipped,
    };
    writeFileSync(join(tempPath, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    renameSync(tempPath, finalPath);
  } catch (err) {
    try {
      rmSync(tempPath, { recursive: true, force: true });
    } catch {
      /* best effort: the original error is more useful */
    }
    throw err;
  }

  const pruned = pruneSnapshots(backupDir, keep);
  return { backupDir, backupPath: finalPath, files, skipped, pruned };
}

/**
 * Remove the oldest recognized snapshots beyond `keep`. Only direct children
 * named `state-<timestamp>` that contain a `manifest.json` are eligible; unknown
 * files/directories are never touched.
 */
function pruneSnapshots(backupDir: string, keep: number): string[] {
  const candidates = readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => /^state-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(entry.name))
    .filter((entry) => existsSync(join(backupDir, entry.name, 'manifest.json')))
    .map((entry) => join(backupDir, entry.name))
    .sort((a, b) => basename(b).localeCompare(basename(a)));

  const pruned: string[] = [];
  for (const path of candidates.slice(keep)) {
    rmSync(path, { recursive: true, force: true });
    pruned.push(path);
  }
  return pruned;
}
