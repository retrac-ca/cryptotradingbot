import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupState, defaultBackupDir } from '../../../src/ops/stateBackup.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRoot(): { root: string; stateDir: string; backupDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'retrac-backup-'));
  dirs.push(root);
  const stateDir = join(root, '.state');
  mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, backupDir: join(root, '.state-backups') };
}

describe('backupState', () => {
  it('copies durable files, skips transient files, and writes a manifest', () => {
    const { stateDir, backupDir } = makeRoot();
    writeFileSync(join(stateDir, 'paper-state.json'), '{"paper":true}', 'utf8');
    writeFileSync(join(stateDir, 'engine-status.json'), '{"engine":true}', 'utf8');
    writeFileSync(join(stateDir, '.mutation.lock'), '{"pid":1}', 'utf8');
    writeFileSync(join(stateDir, 'leftover.tmp'), 'temp', 'utf8');

    const result = backupState({ stateDir, backupDir, nowMs: 1_000 });

    expect(result.files.sort()).toEqual(['engine-status.json', 'paper-state.json']);
    expect(result.skipped.sort()).toEqual(['.mutation.lock', 'leftover.tmp']);
    expect(existsSync(join(result.backupPath, 'paper-state.json'))).toBe(true);
    expect(existsSync(join(result.backupPath, '.mutation.lock'))).toBe(false);
    expect(existsSync(join(result.backupPath, 'leftover.tmp'))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(result.backupPath, 'manifest.json'), 'utf8')) as {
      format: number;
      files: Array<{ name: string }>;
      skipped: string[];
    };
    expect(manifest.format).toBe(1);
    expect(manifest.files.map((f) => f.name).sort()).toEqual([
      'engine-status.json',
      'paper-state.json',
    ]);
    expect(manifest.skipped.sort()).toEqual(['.mutation.lock', 'leftover.tmp']);
  });

  it('retains only the newest N recognized snapshots', () => {
    const { stateDir, backupDir } = makeRoot();
    writeFileSync(join(stateDir, 'paper-state.json'), '{}', 'utf8');
    const base = Date.parse('2026-10-17T00:00:00.000Z');

    backupState({ stateDir, backupDir, keep: 2, nowMs: base });
    backupState({ stateDir, backupDir, keep: 2, nowMs: base + 1000 });
    const third = backupState({ stateDir, backupDir, keep: 2, nowMs: base + 2000 });

    const snapshots = readdirSync(backupDir)
      .filter((name) => name.startsWith('state-'))
      .sort();
    expect(snapshots).toHaveLength(2);
    expect(third.pruned).toHaveLength(1);
    expect(snapshots[0]).toContain('2026-10-17T00-00-01');
    expect(snapshots[1]).toContain('2026-10-17T00-00-02');
  });

  it('never prunes an unrecognized directory', () => {
    const { stateDir, backupDir } = makeRoot();
    writeFileSync(join(stateDir, 'paper-state.json'), '{}', 'utf8');
    const unknown = join(backupDir, 'operator-notes');
    mkdirSync(unknown, { recursive: true });
    writeFileSync(join(unknown, 'keep.txt'), 'keep', 'utf8');

    backupState({ stateDir, backupDir, keep: 1, nowMs: 5_000 });

    expect(existsSync(unknown)).toBe(true);
  });

  it('refuses a backup directory inside STATE_DIR', () => {
    const { stateDir } = makeRoot();
    expect(() =>
      backupState({ stateDir, backupDir: join(stateDir, 'backups') }),
    ).toThrow(/outside STATE_DIR/);
  });

  it('refuses a missing state directory and a non-positive keep value', () => {
    const { root } = makeRoot();
    expect(() =>
      backupState({ stateDir: join(root, 'missing'), backupDir: join(root, 'out') }),
    ).toThrow(/does not exist/);

    const { stateDir, backupDir } = makeRoot();
    expect(() => backupState({ stateDir, backupDir, keep: 0 })).toThrow(/positive integer/);
  });
});

describe('defaultBackupDir', () => {
  it('uses a sibling "<state>-backups" directory', () => {
    expect(basename(defaultBackupDir('/tmp/project/.state/'))).toBe('.state-backups');
  });
});
