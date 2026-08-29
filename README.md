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

**Currently implemented (Phase 1 — Foundation):**
- Project scaffolding (TypeScript, Vitest, ESLint)
- Safe fixed-point money type (`src/money/Money.ts`) — no floating-point money
- Configuration loading + validation from `.env` (zod), with clear errors
- Structured logging (pino) with secret redaction
- A minimal CLI: `setup`, `config`, `paper`, `start`, `status`

The NDAX adapter, strategy engine, risk manager, and execution engine are
planned but not yet implemented.

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

## CLI Commands

| Command | Description |
|---------|-------------|
| `setup` | Create a `.env` file from the template (never overwrites) |
| `config` | Show the effective resolved (non-secret) configuration |
| `paper` | Start the bot in SAFE simulated trading mode |
| `start` | Start the bot (honors `TRADING_MODE`, paper by default) |
| `status` | Show current bot/trading status |

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

## Safety

- **Paper trading is the default.** Simulated orders are always distinctly
  labeled as PAPER and never reach a real exchange order endpoint.
- **Live trading requires deliberate action:** you must set `TRADING_MODE=live`
  **and** `REAL_FUNDS_AT_RISK=true`. Startup fails otherwise.
- A `KILL_SWITCH` immediately blocks all trading.
- Conservative risk limits (`MAX_POSITION_SIZE_FRACTION`,
  `MAX_DAILY_LOSS_FRACTION`, `MAX_OPEN_POSITIONS`, ...) apply.
- API credentials are stored only in your environment / `.env` (which is
  git-ignored) and are never logged.

**Live trading is NOT yet implemented in this build.** Do not set
`REAL_FUNDS_AT_RISK=true` expecting it to place real orders — it is currently a
safety scaffold only.

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
├── persistence/  # database layer
├── engine/       # main trading engine / orchestration
└── backtest/     # backtesting (future)
```

## Security Notes

- Never commit `.env` or any file containing secrets.
- API keys and secrets are only read from the environment, never from source.
- Secrets are never logged or printed by the bot.

## License

MIT
