/**
 * Shared types/helpers for CLI commands.
 */

import type { Logger } from '../logging/logger.js';

export interface CommandContext {
  logger: Logger;
}

export type CommandHandler = (
  args: string[],
  ctx: CommandContext,
) => Promise<number> | number;

export const VERSION = '0.0.1';
