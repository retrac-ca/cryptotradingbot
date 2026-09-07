/**
 * Market universe & eligibility.
 *
 * A multi-user trading bot must NOT automatically trade every market an
 * exchange lists (NDAX lists ~90 instruments, many of them illiquid meme
 * coins). Instead, we maintain a *curated* universe of approved markets,
 * then filter it through *eligibility* so only structurally-tradeable markets
 * are ever evaluated by the coordinator.
 *
 * Eligibility here is structural (from exchange metadata, which is static):
 *   - the symbol is approved (whitelist) — never a random market,
 *   - quoted in the bot's supported quote currency,
 *   - supports market orders,
 *   - has a valid positive price tick and quantity tick,
 *   - exposes a minimum order size, and
 *   - exposes a known fee model.
 *
 * Liquidity / spread / minimum-order-vs-deployable feasibility are evaluated at
 * decision time with live data (see MarketCoordinator), not from unreliable
 * bid/ask order-count fields explicit here.
 */

import type { MarketInfo } from '../types.js';

export interface UniverseFilter {
  /** Quote currency every considered market must be quoted in (e.g. "CAD"). */
  quote: string;
  /**
   * Curated approval whitelist (canonical symbols). When non-empty, only these
   * symbols are ever considered. Empty => all discovered markets are considered
   * (used only by tests / explicit discovery).
   */
  approvedSymbols: string[];
}

export interface EligibleMarket {
  symbol: string;
  /** Market info, or null when the exchange reports no such market. */
  marketInfo: MarketInfo | null;
  eligible: boolean;
  /** Stable machine-readable reason when `eligible` is false. */
  reason: string | null;
}

/** Stable, testable eligibility reasons. */
export const UNIVERSE_REASON = {
  UNSUPPORTED_MARKET: 'UNSUPPORTED_MARKET', // not present in discovered markets
  UNSUPPORTED_QUOTE: 'UNSUPPORTED_QUOTE', // not quoted in the supported quote currency
  NO_MARKET_ORDERS: 'NO_MARKET_ORDERS', // does not support market orders
  INVALID_TICK: 'INVALID_TICK', // missing/zero price or quantity tick
  NO_MIN_ORDER: 'NO_MIN_ORDER', // no minimum order size exposed
  UNKNOWN_FEES: 'UNKNOWN_FEES', // no fee model
  ELIGIBLE: null,
} as const;

/**
 * Evaluate the applied universe of `approvedSymbols` against the exchange's
 * discovered `markets`, returning per-symbol eligibility. Deterministic order:
 * the caller-supplied `approvedSymbols` order is preserved.
 */
export function buildUniverse(markets: MarketInfo[], filter: UniverseFilter): EligibleMarket[] {
  const bySymbol = new Map<string, MarketInfo>();
  for (const m of markets) bySymbol.set(m.symbol, m);

  const names = filter.approvedSymbols.length > 0 ? filter.approvedSymbols : [...bySymbol.keys()];
  const out: EligibleMarket[] = [];

  for (const symbol of names) {
    const m = bySymbol.get(symbol);
    if (!m) {
      out.push({ symbol, marketInfo: null, eligible: false, reason: UNIVERSE_REASON.UNSUPPORTED_MARKET });
      continue;
    }
    const quote = symbol.split('/')[1] ?? '';
    if (quote !== filter.quote) {
      out.push({ symbol, marketInfo: m, eligible: false, reason: UNIVERSE_REASON.UNSUPPORTED_QUOTE });
      continue;
    }
    if (!m.supportsMarketOrders) {
      out.push({ symbol, marketInfo: m, eligible: false, reason: UNIVERSE_REASON.NO_MARKET_ORDERS });
      continue;
    }
    if (!m.priceTick.isPositive() || !m.quantityTick.isPositive()) {
      out.push({ symbol, marketInfo: m, eligible: false, reason: UNIVERSE_REASON.INVALID_TICK });
      continue;
    }
    if (m.minOrderBase === null && m.minOrderQuote === null) {
      out.push({ symbol, marketInfo: m, eligible: false, reason: UNIVERSE_REASON.NO_MIN_ORDER });
      continue;
    }
    if (!m.feeInfo) {
      out.push({ symbol, marketInfo: m, eligible: false, reason: UNIVERSE_REASON.UNKNOWN_FEES });
      continue;
    }
    out.push({ symbol, marketInfo: m, eligible: true, reason: UNIVERSE_REASON.ELIGIBLE });
  }
  return out;
}

/** Convenience: the canonical symbols of the eligible markets. */
export function eligibleSymbols(markets: MarketInfo[], filter: UniverseFilter): string[] {
  return buildUniverse(markets, filter)
    .filter((m) => m.eligible)
    .map((m) => m.symbol);
}
