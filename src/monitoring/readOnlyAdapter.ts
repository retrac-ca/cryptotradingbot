/**
 * Read-only exchange adapter facade (monitoring safety guard).
 *
 * The monitoring layer must NEVER be able to place or cancel an order. This
 * wraps a (possibly write-capable) `ExchangeAdapter` in a runtime proxy that
 * THROWS on `placeOrder`/`cancelOrder` while delegating every read method to the
 * underlying adapter.
 *
 * This mirrors the existing `toReadOnlyAdapter` guard used by `bot manual`
 * (`src/cli/manual-cmd.ts`) and `bot live-monitor`. It is deliberately
 * re-implemented locally so the monitoring module does not import the CLI /
 * manual-bridge / risk modules (which are operator/write-adjacent). No write
 * method can ever be reached through the returned adapter.
 */

import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';

/** Exchange methods that mutate state and MUST NOT be reachable. */
const WRITE_METHODS: ReadonlySet<string> = new Set(['placeOrder', 'cancelOrder']);

/**
 * Return a read-only view of `adapter`. Read methods work as normal; the write
 * methods throw a fail-closed error if anything attempts to call them.
 */
export function createReadOnlyExchangeAdapter(adapter: ExchangeAdapter): ExchangeAdapter {
  const proxy = new Proxy(adapter, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
        return async () => {
          throw new Error(
            'monitoring safety guard: exchange write methods are disabled (read-only monitoring)',
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy as ExchangeAdapter;
}
