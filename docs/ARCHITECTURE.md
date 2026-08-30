# Architecture

This document explains the major components, the data flow, and the reasoning
behind the design. The guiding principles are:

- The core trading engine is **exchange-agnostic** (never imports exchange-specific code).
- **Exchange**, **strategy**, **risk**, **execution**, **portfolio**, **config**, **logging**, and **persistence** are separate concerns.
- **Safety first**: paper trading by default; live trading requires deliberate opt-in.
- Strong TypeScript types and small modules.

## Phased Plan & Current Progress

| Phase | Deliverable | Status |
|-------|-------------|--------|
| 1 | Project foundation + architecture | **DONE** |
| 2 | Configuration + secrets | **DONE** |
| 3 | Exchange abstraction | **DONE** |
| 4 | NDAX adapter | **DONE** (verified live 2026-08-28) |
| 5 | Market data | **DONE** |
| 6 | Strategy engine | **DONE** |
| 7 | Risk management | **DONE** |
| 8 | Paper trading | **DONE** |
| 9 | Persistence + reconciliation | **DONE** |
| 10 | Backtesting | **DONE** |
| 11 | Live trading safeguards | **DONE** (engine + reconciliation tested; NDAX order placement remains **disabled**, fail-closed, until verified against a live account) |
| 12 | CLI / UX | **DONE** |
| 13 | Docs + packaging | **DONE** |

Phases are implemented and reviewed incrementally, not all at once.

## High-Level Data Flow

The core principle is that a strategy **never places an order** directly. The
interpretation flows through layered components:

```
Market Data
   → Strategy (generates Signal: BUY / SELL / HOLD)
   → Signal
   → Risk Manager (approve or reject)
   → Portfolio / Position Manager (sizing, exposure)
   → Execution Engine
   → Exchange Adapter (NDAX, ...)
```

## Core Components (Directory Map)

### `src/money/Money.ts` — Safe financial arithmetic
All money, prices, quantities, fees, and P&L use fixed-point **BigInt** math
(scale 8) instead of JavaScript doubles. See `docs/DECISIONS.md` for details.
This underpins every financial calculation and prevents
`0.1 + 0.2 !== 0.3`-class bugs.

### `src/types.ts` / `src/order.ts` — Domain value types
Exchange-agnostic canonical models: `Ticker`, `Candle`, `OrderBook`, `Trade`,
`Balance`, `MarketInfo`, `Signal`, `Order`, and order request/status types.
Adapters translate exchange JSON into these; the engine only ever sees these.

### `src/logging/logger.ts` — Observability
Pino-based structured (JSON) logging with sane development pretty-printing and
**secret redaction**. No secrets are ever logged.

### `src/config/` — Configuration
- `schema.ts`: zod schema for every setting plus cross-field validation.
- `load.ts`: loads a `.env` file, normalizes `SCREAMING_SNAKE_CASE` env keys to
  camelCase, validates, and returns a single typed `BotConfig`.

### `src/cli/` — User interface
Minimal command dispatcher. Commands: `setup`, `config`, `paper`, `start`,
`status`, `backtest`, `trades`, and `reconcile`. Each is a small module. The
CLI is crafted so non-technical users can get running without editing source.

### `src/exchanges/` — exchange adapters behind one interface
- `src/exchanges/ExchangeAdapter.ts` — the interface engines depend on.
- `src/exchanges/ndax/` — the NDAX implementation (live-verified public reads).
- Future exchanges plug in via the registry without engine changes.

### `src/marketdata/` — market data abstraction
- **`LiveMarketData`** — a polling snapshot provider over `ExchangeAdapter`.
  Fetches ticker/order-book/candles on a fixed cadence, exposes the latest
  snapshot synchronously for the strategy, and emits typed events (`ticker`,
  `orderBook`, `candles`, `failure`). Handles sparse data and transient errors —
  a failed poll never throws into the caller (records the error, keeps the
  previous snapshot, retries next tick; events use `failure`, not `error`, so an
  unhandled listener cannot crash the process).
- `MarketDataProvider` is the read-only interface strategies consume;
  historical/simulated providers (backtesting) implement it later.
- **`src/strategy/`** — `Strategy` interface emitting `Signal`s only.
- **`src/risk/`** — `RiskManager` deciding approve/reject **and sizing**.
  It sits between signals and execution: strategies never choose order size or
  enforce account-level limits. Given a signal + a read-only `RiskContext`
  snapshot it produces a typed `RiskDecision` (approved/rejected + reason code +
  quantity + notional + applied limits). Enforces max trade size, per-asset
  position, portfolio exposure, daily loss, max drawdown, cooldown, kill switch,
  and exchange market-constraint validation. **Fail-closed** on unavailable or
  stale state. Risk-reducing SELLs are allowed even when new exposure is
  prohibited (long-only V1: a SELL never exceeds the held position).
- **`src/portfolio/`** — cash, positions, average entry price, cost basis,
  realized/unrealized P&L, and exposure using exact `Money`. `applyFill` handles
  opening/scaling a long (BUY) and reducing/closing it (SELL), and `markToMarket`
  prices the book from current market prices. `serialization.ts` persists a
  `PortfolioModel` as decimal strings so it round-trips a restart exactly.
- **`src/execution/`** — `PaperExecutionEngine` simulates fills locally: market
  and limit orders, configurable fees, slippage, partial fills (`fillFraction`),
  order cancellation, and a long-only safety net. It has **no** reference to a
  real exchange adapter and **no** live order-placement path.
  `LiveOrderEngine` moves fully risk-approved orders to the real exchange with
  strict safety controls: a **gated start** (`tradingMode=live` +
  `realFundsAtRisk` + `supportsOrderPlacement`), **persist-before-submit**
  (writes the order to the `OrderStore` as CREATED before any network call, so a
  crash can never cause a duplicate), **no auto-retry on ambiguous outcomes**
  (timeout/unknown → `UNKNOWN`, reconcile with the exchange instead), and
  precision + balance validation against the live exchange. Any uncertainty
  fails closed.
- **`src/persistence/`** — `PaperStateStore`, a minimal JSON state file
  (atomic write via temp+rename) storing the portfolio plus executed paper order
  ids, so a restart does not reset the account. `OrderStore` persists the
  durable order ledger keyed by `clientOrderId` (Money stored as decimal
  strings), which underpins duplicate-order prevention and reconciliation.
- **`src/reconcile/`** — `Reconciler` compares the bot's local order ledger
  against the exchange's **authoritative** balances/open orders/history and
  classifies discrepancies; `ReconcileService` fetches the exchange snapshot via
  the adapter (failing closed if any read fails). The exchange is authoritative;
  the bot never "fixes" a discrepancy by guessing.
- **`src/engine/`** — `PaperEngine` (Phase 8) wires everything into one
  continuously-running loop: `Market Data → Strategy → Signal → Risk → Paper
  Execution → Portfolio → Logging/Persistence`. It ticks on a fixed cadence
  (no busy loop), fails closed on stale/unknown market data, and shuts down
  gracefully, persisting on stop. `buildEngine.ts` is the composition root that
  assembles the dependency graph from config.
- **`src/backtest/`** — `BacktestRunner` replays historical candles through the
  strategy → risk → execution pipeline with simulated execution and reports the
  required performance metrics. The `backtest` CLI reads candles from a JSON
  file. `computeMetrics` produces starting/ending capital, total return, trade
  count, win rate, realized P&L, fees, max drawdown, and largest win/loss.
  Results are a historical simulation, not a prediction.

## Safety Model

- Default mode is `paper`. Simulated orders never reach an exchange order
  endpoint and are always labeled PAPER.
- `live` mode requires `TRADING_MODE=live` **and** `REAL_FUNDS_AT_RISK=true`.
- `KILL_SWITCH` hard-stops trading; the `LiveOrderEngine` refuses to operate
  while it is active.
- Conservative risk limits apply.
- Every order is persisted **before** submission keyed by `clientOrderId`, so a
  crash/restart cannot create a duplicate order.
- Ambiguous order submissions (timeout/unknown/network errors) are **not**
  auto-retried. The order is marked `UNKNOWN` and reconciled with the exchange
  (`GetOrderStatus`/`GetOpenOrders`) before any action.
- Reconciliation treats the exchange as authoritative and fails closed on any
  read failure or discrepancy.
- NDAX real order placement is **disabled** (`supportsOrderPlacement=false`)
  and stays that way until its order semantics and private-header signing are
  verified against a live account. The live execution engine still enforces all
  gates and is fully tested via the exchange adapter interface.

## Security Model

- API credentials come only from the environment (`.env`), never source code.
- `.env` is git-ignored; `.env.example` documents the required variables.
- Secrets are never logged or printed.
- The persisted config stores only non-secret values.
