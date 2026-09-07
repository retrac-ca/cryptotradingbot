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

**Currently implemented (V1, PAPER-first):**
- Project scaffolding (TypeScript, Vitest, ESLint) and a safe fixed-point money
  type (`src/money/Money.ts`) — no floating-point money
- Configuration loading + validation from `.env` (zod), with clear errors, and
  structured logging (pino) with secret redaction
- A CLI: `setup`, `config`, `paper`, `start`, `status`, `backtest`, `trades`,
  `reconcile`, `live-test`, `manual`
- The NDAX exchange adapter (read-only public market data; authenticated account
  reads gated behind `ENABLE_AUTHENTICATED_READS`)
- A polling market-data provider, a moving-average-crossover strategy, and a
  full risk manager (sizing, exposure, loss/drawdown limits, kill switch)
- A multi-asset **universe coordinator** that filters the curated universe
  through eligibility and selects at most one risk-approved trade per cycle
- A portfolio tracker with exact P&L, ownership (bot-managed vs external), and
  order-linked reservations, driving a **continuous, restart-safe paper trading
  engine** (market data → strategy → risk → paper execution → portfolio →
  persistence)
- A **persistence/recovery subsystem** — atomic state envelopes, a state
  mutation lock, an initialization marker, and fail-closed startup recovery
- A **V1 reconciliation** module (execution correlation, completeness, fee
  disposition, balances, reservations, cross-domain) with a read-only
  `bot reconcile` and a gated `--commit`
- A **manual execution bridge** (`bot manual`) — operator-mediated; it never
  places or cancels an exchange order
- A **backtesting** module (`bot backtest`) that replays historical candles
  through the strategy → risk → execution pipeline and reports performance
- A **live execution engine** with strict safety controls, and the NDAX
  SendOrder/CancelOrder network paths — both kept **disabled**
- An **explicit live-confirmation mechanism** — `bot start` requires
  `TRADING_MODE=live` + `REAL_FUNDS_AT_RISK=true` **and** a per-invocation
  `--confirm-live` flag before it will even consider live mode

**Live order execution is not yet enabled for NDAX.** The live execution engine,
reconciliation, and the order-placement network paths are implemented and fully
tested, but the NDAX adapter keeps real order placement **disabled**
(`supportsOrderPlacement=false`) because NDAX order-submission semantics and
private-header signing have not yet been verified against a live account and
there is no official public testnet. Live trading therefore fails closed (even
`bot start --confirm-live` refuses) until that is individually validated.

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

A fresh clone can be up and running in PAPER mode like this:

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file:

   ```bash
   npm run dev -- setup
   # or: cp .env.example .env
   ```

   Then edit `.env` to set your exchange and trading parameters. The defaults
   already run PAPER mode safely, so you can start with an unmodified copy.

3. Build the application. `npm start` runs the compiled output
   (`node dist/index.js`), so the build is required first:

   ```bash
   npm run build
   ```

4. Run the bot in **paper (simulated)** mode — this never submits real orders:

   ```bash
   npm start -- paper
   ```

   The paper bot evaluates the configured strategy on a fixed cadence against
   live market data, runs every signal through the risk manager, fills orders
   through a local simulator (fees/slippage/partial fills), and updates a paper
   portfolio. Press `Ctrl-C` to stop it gracefully. `npm start -- status` shows
   the current paper portfolio.

   During development (to skip the build step), use `npm run dev -- paper`
   instead — it runs the TypeScript source directly via `tsx`.

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
| `live-test` | One-shot, operator-gated live SELL (`sell [--target-cad <N>] [--confirm-live]`) — the safe-first live order |
| `manual` | Constrained manual-execution bridge (operator interface; records/validates/accounts evidence; never places or cancels an exchange order) |

Run `npm start -- help` for usage.

## Configuration

All configuration lives in environment variables loaded from a `.env` file.
Copy `.env.example` to `.env` and edit it. See `.env.example` for every
available option with comments.

Key settings:
- `TRADING_MODE=paper` — **always default and safest.** Switch to `live` only
  deliberately (see below).
- `EXCHANGE=ndax` — which exchange adapter to use.
- `TRADING_PAIRS=BTC/CAD` — comma-separated symbols (used for the single-pair
  `live-test` gate).
- `UNIVERSE_MARKETS=BTC/CAD,ETH/CAD,SOL/CAD,XRP/CAD,ADA/CAD` — the bot's **curated
  multi-asset universe**. Only these markets are ever evaluated; each is filtered
  through eligibility (quote currency, valid ticks, min order, fees, market
  orders). This replaces blind trading of every listed market.
- `STRATEGY` / `TIMEFRAME` — strategy selection and candle timeframe.
- `MAX_*` risk controls — conservative defaults safe to leave as-is.
- Paper-mode knobs (safe to leave as-is): `PAPER_STARTING_BALANCE` (starting
  cash for the paper account, default 10000 in the quote currency),
  `PAPER_FEE_FRACTION`, `PAPER_SLIPPAGE_FRACTION`, `PAPER_FILL_FRACTION`, and
  `EVALUATE_INTERVAL_SECONDS` (how often the engine re-evaluates).
- State locations: `STATE_DIR` (default `.state/`) is the single directory
  under which every durable state file lives. `PAPER_STATE_FILE`,
  `LIVE_MANAGED_STATE_FILE`, `ORDER_LEDGER_FILE`, and `MANUAL_INTENT_FILE`
  default to files under it (see below). `LIVE_MANAGED_STATE_FILE` is the
  separate store for the bot's **live managed** inventory and must differ from
  `PAPER_STATE_FILE` (the config refuses to run if they are the same).

### State directory and runtime files

All durable runtime state lives under `STATE_DIR` (default `.state/`). The
following files are created there and are git-ignored — do not commit them:

- `paper-state.json` — the persisted paper portfolio (cash, positions, P&L,
  executed order ids)
- `live-managed-state.json` — the bot's authorized live-managed inventory
  (kept separate from paper state)
- `order-ledger.json` — the durable order ledger, keyed by `clientOrderId`
- `manual-intents.json` — manual-execution intents (Gate 9)
- `.init.json` — the per-realm initialization marker, used to distinguish a
  genuine first run from unexpected state loss (a missing state file after
  initialization fails closed rather than re-seeding)
- `.mutation.lock` — the state-directory mutation lock (fail-closed; removed on
  a clean release)

The configuration refuses to start if `PAPER_STATE_FILE` and
`LIVE_MANAGED_STATE_FILE` are the same, or if any state file is outside
`STATE_DIR`.

### NDAX API credentials

The bot talks to the NDAX exchange (https://ndax.io). Public market data needs
no credentials. Account reads — balances, order history, `bot reconcile`, and
the `bot manual` bridge — require NDAX API credentials: `NDAX_API_KEY`,
`NDAX_API_SECRET`, and a numeric `NDAX_USER_ID` (see `docs/NDAX_API.md`). These
are created from your NDAX account settings.

Credentials are used only for authenticated, read-only account access and are
gated behind `ENABLE_AUTHENTICATED_READS` (default `false`). **Providing
credentials does NOT enable autonomous live trading** — NDAX order placement
remains disabled (`supportsOrderPlacement=false`), and no credential or
configuration change can turn on autonomous live order placement.

> **Ownership model (Gate 5):** the bot maintains a **bot-managed** portfolio. It
> only ever sells what it manages, and only ever buys with the deployable quote
> it controls. Exchange assets that already exist are **external** (recorded as an
> onboarding snapshot) and are never automatically sold and never count as the
> bot's position or exposure. The bot never takes silent control of your existing
> crypto.

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
- **Live trading requires deliberate action, twice over:** you must set
  `TRADING_MODE=live` **and** `REAL_FUNDS_AT_RISK=true` **and** pass
  `--confirm-live` on every `bot start` invocation. Startup fails otherwise.
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

**Live order placement is not yet enabled for NDAX.** The live execution engine,
reconciliation, and the NDAX SendOrder/CancelOrder network paths exist and are
tested, but the NDAX adapter refuses real order placement
(`supportsOrderPlacement=false`) until its order semantics and private-header
signing are verified against a live account. Live mode fails closed.

## Known Limitations

These are documented limitations that do **not** invalidate the PAPER-first V1,
but they are important to understand before relying on the live/manual realm:

- **Candle-series freshness is not age-checked at decision time.** The strategy
  decision path checks ticker/quote freshness (quote age, transport age, and
  future-skew), but does **not** explicitly age-check the candle series the
  strategy evaluates. This means a strategy could theoretically evaluate a stale
  candle series while the ticker is fresh enough for risk approval. This is a
  **P2 LIVE-readiness limitation** — it is **not** a demonstrated failure of the
  completed 24-hour PAPER soak (the soak's 22 `STALE_MARKET_DATA` events were
  ticker/quote-freshness rejections, not candle staleness). It must be addressed
  before autonomous NDAX LIVE trading could be considered. Note autonomous NDAX
  LIVE remains disabled independently for the broader NDAX capability/evidence
  reasons above.
- **Two reconciliation paths coexist.** The newer V1 (`bot reconcile` →
  `reconcile()`/`commitProven()`) performs execution-level correlation,
  completeness analysis, fee disposition, reservation and balance reconciliation,
  and an explicit commit gate; the older V0 (`ReconcileService`/`Reconciler`)
  is still used by some live-test/live-engine paths. An important behavioral
  difference: V1 **surfaces** unexpected external exchange balances, whereas V0's
  balance check iterates only the currencies the bot already expects and therefore
  does **not** surface unexpected currencies (though neither path auto-adopts
  them). This is a known architectural coexistence/observability limitation, not
  an adoption risk.

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
├── persistence/  # state envelopes, stores, mutation lock, startup recovery
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
