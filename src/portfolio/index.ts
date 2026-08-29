/**
 * Portfolio module.
 *
 * Tracks cash, open positions, average entry price, cost basis, realized and
 * unrealized P&L, fees, market value, and exposure — all with `Money`.
 */

export { Portfolio } from './Portfolio.js';
export type { PortfolioModel, PaperPosition, CashFlow } from './types.js';
export { serializePortfolio, deserializePortfolio } from './serialization.js';
export type { PortfolioJsonV1 } from './serialization.js';
