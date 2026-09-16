/**
 * Shared types/helpers for CLI commands.
 */

import { readFileSync } from 'node:fs';
import type { Logger } from '../logging/logger.js';

export interface CommandContext {
  logger: Logger;
}

export type CommandHandler = (
  args: string[],
  ctx: CommandContext,
) => Promise<number> | number;

/**
 * Read the package version from `package.json` so the CLI version has a single
 * source of truth and cannot drift from the package/release metadata.
 *
 * Resolves relative to this module (`src/cli` in dev, `dist/cli` in a build),
 * so `../../package.json` is always the repository/package root. Falls back to
 * a neutral placeholder if the file is unreadable (never throws at import).
 */
function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readPackageVersion();
