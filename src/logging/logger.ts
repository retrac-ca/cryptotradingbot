/**
 * Structured logging setup.
 *
 * Logs are emitted as JSON (via pino) so they can be parsed by external
 * tooling, with a prettified human-friendly view in local development.
 *
 * SECURITY: sensitive values (API keys, secrets, auth tokens) are redacted
 * where they might appear in log payloads. Callers must additionally never log
 * secret values in the first place. We also strip a configurable set of known
 * secret key names.
 */

import pino from 'pino';

const DEFAULT_REDACT_PATHS = [
  'NDAX_API_KEY',
  'NDAX_API_SECRET',
  'apiKey',
  'apiSecret',
  'secret',
  'password',
  'token',
  'authorization',
  'Authorization',
  'x-api-key',
];

export interface Logger {
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  fatal(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

interface LoggerOptions {
  level?: string;
  redactPaths?: string[];
  pretty?: boolean;
}

function wrap(pinoLogger: pino.Logger): Logger {
  const emit = (fn: (obj: unknown, msg: string) => void) => {
    return (obj: unknown, msg?: string) => fn(obj, msg ?? '');
  };
  return {
    trace: emit(pinoLogger.trace.bind(pinoLogger)),
    debug: emit(pinoLogger.debug.bind(pinoLogger)),
    info: emit(pinoLogger.info.bind(pinoLogger)),
    warn: emit(pinoLogger.warn.bind(pinoLogger)),
    error: emit(pinoLogger.error.bind(pinoLogger)),
    fatal: emit(pinoLogger.fatal.bind(pinoLogger)),
    child: (bindings) => wrap(pinoLogger.child(bindings)),
  };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? (process.env.LOG_LEVEL ?? 'info');
  const redact = [...DEFAULT_REDACT_PATHS, ...(options.redactPaths ?? [])];

  const pinoLogger = pino({
    level,
    redact: {
      paths: redact,
      censor: '[REDACTED]',
    },
    ...(options.pretty || process.env.NODE_ENV !== 'production'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
          },
        }
      : {}),
  });

  return wrap(pinoLogger);
}
