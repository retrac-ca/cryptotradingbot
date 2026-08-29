/**
 * Configuration loading.
 *
 * Loads environment variables from a `.env` file (if present), validates them
 * against the zod schema, applies start-up cross-field validation, and returns
 * a single typed `BotConfig`.
 *
 * If required values are missing or invalid, throws errors with clear, human-
 * readable messages so users know exactly what to fix.
 */

import dotenv from 'dotenv';
import { ZodError } from 'zod';
import { botConfigSchema, validateConfig, type BotConfig } from './schema.js';

export class ConfigLoadError extends Error {
  readonly details: Record<string, string[]>;
  constructor(details: Record<string, string[]>) {
    const lines = Object.entries(details).flatMap(([key, msgs]) =>
      msgs.map((m) => `  - ${key}: ${m}`),
    );
    super(`Configuration is invalid:\n${lines.join('\n')}`);
    this.name = 'ConfigLoadError';
    this.details = details;
  }
}

/**
 * Convert SCREAMING_SNAKE_CASE environment keys to the camelCase keys used by
 * the config schema, e.g. TRADING_PAIRS -> tradingPairs. Unknown keys are
 * dropped (zod ignores non-schema keys anyway).
 */
function normalizeKeys(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) continue;
    const camel = key
      .toLowerCase()
      .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[camel] = env[key];
  }
  return out;
}

/** Load, validate, and return the resolved bot configuration. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  dotenv.config();
  const normalized = normalizeKeys(env);

  const parsed = botConfigSchema.safeParse(normalized);

  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of (parsed.error as ZodError).issues) {
      const key = issue.path.join('.') || '(root)';
      details[key] ??= [];
      details[key]!.push(issue.message);
    }
    throw new ConfigLoadError(details);
  }

  try {
    validateConfig(parsed.data);
  } catch (err) {
    throw new ConfigLoadError({
      '(validation)': [err instanceof Error ? err.message : String(err)],
    });
  }

  return parsed.data;
}

/** Reloadable config holder so tests can inject custom env. */
export function loadConfigFrom(source: Record<string, string | undefined>): BotConfig {
  return loadConfig(source as NodeJS.ProcessEnv);
}
