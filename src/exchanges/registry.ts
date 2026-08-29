/**
 * Exchange registry — maps an exchange name (from config) to a factory that
 * builds an `ExchangeAdapter`. The trading engine asks the registry for the
 * adapter at startup; it never constructs concrete exchanges directly.
 *
 * This keeps the engine decoupled from concrete exchange classes and makes it
 * easy to add new exchanges (coinbase, kraken, ...) without engine changes.
 */

import type { ExchangeAdapter } from './ExchangeAdapter.js';

export interface ExchangeAdapterFactory {
  (deps: { credentials: Record<string, string>; config?: Record<string, unknown>; }): ExchangeAdapter;
}

const factories = new Map<string, ExchangeAdapterFactory>();

/** Register an exchange factory (called once at import time by each adapter). */
export function registerExchange(name: string, factory: ExchangeAdapterFactory): void {
  factories.set(name, factory);
}

export function getSupportedExchanges(): string[] {
  return [...factories.keys()];
}

export function isExchangeSupported(name: string): boolean {
  return factories.has(name);
}

/** Build an adapter for the named exchange with the given credentials. */
export function createExchange(
  name: string,
  deps: { credentials: Record<string, string>; config?: Record<string, unknown> },
): ExchangeAdapter {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(
      `Exchange "${name}" is not available. Supported exchanges: ${
        getSupportedExchanges().join(', ') || '(none registered yet)'
      }`,
    );
  }
  return factory(deps);
}

export function resetExchangeRegistry(): void {
  factories.clear();
}
