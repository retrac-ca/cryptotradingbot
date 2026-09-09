/**
 * Portfolio module.
 *
 * Tracks cash, open positions, average entry price, cost basis, realized and
 * unrealized P&L, fees, market value, and exposure — all with `Money`.
 */

export { Portfolio } from './Portfolio.js';
export type {
  PortfolioModel,
  PaperPosition,
  CashFlow,
  PositionSource,
  SourceQuantities,
  OrderReservation,
  ReservationStatus,
  AppliedExecution,
  ManualSettlement,
  LiveOrderAttestation,
  ExchangeEvidenceSnapshot,
  AccountTradeEvidence,
  BalanceEvidence,
} from './types.js';
export { serializePortfolio, deserializePortfolio, PORTFOLIO_STATE_VERSION } from './serialization.js';
export type {
  PortfolioJsonV1,
  PortfolioJsonV2,
  PortfolioJson,
  PositionJsonV1,
  PositionJsonV2,
  PositionJson,
  StateRealm,
} from './serialization.js';
