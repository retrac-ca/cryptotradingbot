/**
 * `bot backup-state` — snapshot the durable state directory.
 *
 * READ-ONLY with respect to bot state: copies every durable state file into a
 * timestamped backup directory, writes a manifest, and prunes old recognized
 * snapshots. It never contacts the exchange, never mutates trading state, and
 * never acquires the mutation lock (so it cannot block the engine).
 */

import { loadConfig } from '../config/load.js';
import { backupState, defaultBackupDir } from '../ops/stateBackup.js';
import type { CommandHandler } from './context.js';

const USAGE = `bot backup-state — snapshot STATE_DIR (read-only; never mutates bot state)

Usage: bot backup-state [options]

Options:
  --dir <path>    backup directory (default: sibling "<STATE_DIR>-backups")
  --keep <n>      snapshots to retain (default: 14)
  --json          machine-readable output
  --help          show this help

The snapshot skips .mutation.lock and *.tmp, writes a manifest.json, and prunes
only recognized "state-<timestamp>" directories that contain a manifest.
Exit codes: 0 success, 1 error.
`;

interface ParsedArgs {
  dir?: string;
  keep?: number;
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs | { error: string } {
  const parsed: ParsedArgs = { json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--dir') {
      const value = args[++i];
      if (!value) return { error: 'missing value for --dir' };
      parsed.dir = value;
    } else if (arg === '--keep') {
      const value = args[++i];
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) {
        return { error: `--keep must be a positive integer (got "${value}")` };
      }
      parsed.keep = n;
    } else {
      return { error: `unknown flag "${arg}"` };
    }
  }
  return parsed;
}

export const backupStateCommand: CommandHandler = async (
  args,
  { logger },
): Promise<number> => {
  if (args.includes('--help') || args.includes('-h')) {
    // eslint-disable-next-line no-console
    console.log(USAGE);
    return 0;
  }

  const parsed = parseArgs(args);
  if ('error' in parsed) {
    // eslint-disable-next-line no-console
    console.error('Argument error: ' + parsed.error + '\n');
    // eslint-disable-next-line no-console
    console.log(USAGE);
    return 1;
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + message);
    return 1;
  }

  const dir = parsed.dir ?? defaultBackupDir(cfg.stateDir);
  try {
    const result = backupState({
      stateDir: cfg.stateDir,
      backupDir: dir,
      ...(parsed.keep !== undefined ? { keep: parsed.keep } : {}),
    });

    if (parsed.json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
    } else {
      // eslint-disable-next-line no-console
      console.log(`State backup: ${result.backupPath}`);
      // eslint-disable-next-line no-console
      console.log(`  files:   ${result.files.length} (${result.files.join(', ') || 'none'})`);
      if (result.skipped.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`  skipped: ${result.skipped.join(', ')}`);
      }
      if (result.pruned.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`  pruned:  ${result.pruned.length} old snapshot(s)`);
      }
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'state backup failed');
    // eslint-disable-next-line no-console
    console.error('State backup failed: ' + message);
    return 1;
  }
};
