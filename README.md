# Cryptocurrency Trading Bot

A modular, exchange-agnostic cryptocurrency trading bot designed to be safe by
default. The core trading engine is completely decoupled from any specific
exchange, so the same architecture works with NDAX today and other exchanges in
the future without rewriting trading logic.

> **WARNING:** Trading cryptocurrency is risky. This bot is provided for
> educational/experimental use. It defaults to **paper (simulated) trading**
> and never submits a real order unless you explicitly and deliberately enable
> live mode. Nothing here guarantees profitability.

## Status

This project is under active development, built incrementally in phases. See
`docs/ARCHITECTURE.md` for the full plan and current progress.

**Currently implemented (Phases 1–9):**
- Project scaffolding (TypeScript, Vitest, ESLint)
- Safe fixed-point money type (`src/money/Money.ts`) — no floating-point money
- Configuration loading + validation from `.env` (zod), with clear errors
- Structured logging (pino) with secret redaction
- A minimal CLI: `setup`, `config`, `paper`, `start`, `status`
- The NDAX exchange adapter (public market data, live-verified)
- A polling market-data provider, a moving-average-crossover strategy, and a
  full risk manager (sizing, exposure, loss/drawdown limits, kill switch)
- A portfolio tracker with exact P&L, and a **continuous, restart-safe paper
  trading engine** that runs the whole real-time pipeline without touching a
  live order endpoint
- A **durable order ledger** (`.order-ledger.json`) keyed by `clientOrderId`
  that prevents duplicate order submission across crashes/restarts
- A **reconciliation** module that compares the bot's local order ledger against
  the exchange's authoritative balances/open orders/history and fails safe on
  any discrepancy
- A **live execution engine** with strict safety controls (gated start,
  persist-before-submit, no auto-retry on ambiguous outcomes, precision and
  balance validation) behind the exchange adapter
- A **backtesting** module (`bot backtest`) that replays historical candles
  through the strategy → risk → execution pipeline and reports performance
- CLI commands: `backtest`, `trades`, and read-only `reconcile`

**Live order execution is not yet enabled for NDAX.** The live execution engine
and reconciliation are implemented and fully tested, but the NDAX adapter keeps
real order placement **disabled** (`supportsOrderPlacement=false`) because NDAX
order-submission semantics and private-header signing have not yet been verified
against a live account and there is no official public testnet. Live trading
therefore fails closed until that is individually validated.

## Requirements

- Node.js **>= 22**
- npm

## Installation

```bash
git clone <your-repo-url>
cd cryptotradingbot
npm install
```

## Quick Start (Safe, Paper Mode)

1. Create a `.env` file:

   ```bash
   npm start -- setup
   # or: cp .env.example .env
   ```

2. Edit `.env` to set your exchange (and optionally market-data API
   credentials) and trading parameters.

3. Run the bot in **paper (simulated)** mode — this never submits real orders:

   ```bash
   npm start -- paper
   ```

   The paper bot evaluates the configured strategy on a fixed cadence against
   live market data, runs every signal through the risk manager, fills orders
   through a local simulator (fees/slippage/partial fills), and updates a paper
   portfolio. Press `Ctrl-C` to stop it gracefully. `npm start -- status` shows
   the current paper portfolio.

## CLI Commands

| Command | Description |
|---------|-------------|
| `setup` | Create a `.env` file from the template (never overwrites) |
| `config` | Show the effective resolved (non-secret) configuration |
| `paper` | Start the bot in SAFE simulated trading mode |
| `start` | Start the bot (honors `TRADING_MODE`, paper by default) |
| `status` | Show current bot/trading status |
| `backtest <candles.json>` | Run a historical backtest and report performance |
| `trades` | Show the durable order ledger |
| `reconcile` | Reconcile local ledger against the exchange (read-only) |

Run `npm start -- help` for usage.

## Configuration

All configuration lives in environment variables loaded from a `.env` file.
Copy `.env.example` to `.env` and edit it. See `.env.example` for every
available option with comments.

Key settings:
- `TRADING_MODE=paper` — **always default and safest.** Switch to `live` only
  deliberately (see below).
- `EXCHANGE=ndax` — which exchange adapter to use.
- `TRADING_PAIRS=BTC/CAD` — comma-separated symbols.
- `STRATEGY` / `TIMEFRAME` — strategy selection and candle timeframe.
- `MAX_*` risk controls — conservative defaults safe to leave as-is.
- Paper-mode knobs (safe to leave as-is): `PAPER_STARTING_BALANCE` (starting
  cash for the paper account, default 10000 in the quote currency),
  `PAPER_FEE_FRACTION`, `PAPER_SLIPPAGE_FRACTION`, `PAPER_FILL_FRACTION`,
  `EVALUATE_INTERVAL_SECONDS` (how often the engine re-evaluates), and
  `PAPER_STATE_FILE` (where the paper portfolio is persisted between restarts,
  default `.paper-state.json`). `ORDER_LEDGER_FILE` (default `.order-ledger.json`)
  is where the durable order ledger is kept.

### Backtesting

```bash
npm start -- backtest <candles.json> --initial-capital 10000 --fee 0.002
```

The candles file is a JSON array of canonical candle objects
(`symbol`, `timeframe`, `timestampMs`, `open`, `high`, `low`, `close`,
`baseVolume`). The bot replays them through the strategy → risk → execution
pipeline and reports starting/ending capital, total return, trade count,
win rate, realized P&L, fees, max drawdown, and largest win/loss.

> ⚠️ Backtest results are a **historical simulation** — not a prediction of
> future performance.

## Safety

- **Paper trading is the default.** Simulated orders are always distinctly
  labeled as PAPER and never reach a real exchange order endpoint.
- **Live trading requires deliberate action:** you must set `TRADING_MODE=live`
  **and** `REAL_FUNDS_AT_RISK=true`. Startup fails otherwise.
- A `KILL_SWITCH` immediately blocks all trading.
- Conservative risk limits (`MAX_POSITION_SIZE_FRACTION`,
  `MAX_DAILY_LOSS_FRACTION`, `MAX_OPEN_POSITIONS`, ...) apply.
- The order ledger is written **before** any order is submitted, so a
  crash/restart can never cause a duplicate order; ambiguous submissions are
  reconciled with the exchange rather than auto-retried.
- `bot reconcile` compares the local ledger against the exchange's authoritative
  state and reports (read-only). Trading should pause while discrepancies exist.
- API credentials are stored only in your environment / `.env` (which is
  git-ignored) and are never logged.

**Live order placement is not yet enabled for NDAX.** The live execution engine
and reconciliation exist and are tested, but the NDAX adapter refuses real order
placement until its order semantics and private-header signing are verified
against a live account. Live mode fails closed.

## Development

```bash
npm run typecheck   # TypeScript type checking
npm test            # run the test suite (Vitest)
npm run lint        # ESLint
npm run build       # compile to dist/
```

## Project Structure

See `docs/ARCHITECTURE.md` for a full explanation of the architecture and data
flow. Overview of the source layout:

```
src/
├── cli/          # command-line interface
├── config/       # schema + validation
├── money/        # safe fixed-point money type
├── logging/      # structured logging + redaction
├── exchanges/    # exchange adapters (NDAX... future)
├── marketdata/   # market data abstraction
├── strategy/     # strategy interface + implementations
├── risk/         # risk management
├── portfolio/    # position/portfolio management
├── execution/    # paper/live execution engines
├── persistence/  # paper state + order ledger
├── engine/       # main trading engine / orchestration
├── reconcile/    # order-ledger vs exchange reconciliation
└── backtest/     # historical backtesting
```

## Security Notes

- Never commit `.env` or any file containing secrets.
- API keys and secrets are only read from the environment, never from source.
- Secrets are never logged or printed by the bot.

## License

MIT
