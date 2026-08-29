# Design Decisions

This file records the rationale behind significant architectural and
implementation choices, so future developers understand *why* the code is
structured this way. Each entry answers: what was chosen, why, and what
alternatives were rejected.

## 1. Fixed-Point BigInt Money (no floating point for finances)

**Decision:** All money, prices, quantities, fees, and P&L are represented as
fixed-point scaled integers using native `BigInt` (scale 8), encapsulated in
`src/money/Money.ts`.

**Why:** JavaScript doubles (IEEE-754 binary64) cannot represent most decimal
fractions exactly (`0.1 + 0.2 === 0.30000000000000004`). Any such error can
silently corrupt order quantities, position sizing, fees, or P&L in a trading
bot. BigInt integer arithmetic is exact. A fixed scale keeps arithmetic simple
and predictable while covering typical crypto precision (BTC to 8 decimals).

**Alternatives rejected:**
- Raw `number` — rejected (floating-point error risk).
- `decimal.js` / `big.js` arbitrary-precision — not needed yet; the core
  operations (add/sub/compare/multiply-by-fraction) are covered by BigInt.
  Can be layered in later for strategy math (log/sqrt/pow) without changing how
  values are stored.

## 2. Zod for configuration schema + validation

**Decision:** `zod` defines the config schema and performs start-up validation.

**Why:** Zod gives strong TypeScript inference, precise error messages, and
coercion from strings (since env vars are all strings), in one tool with no
extra glue.

**How it maps:** env vars are SCREAMING_SNAKE_CASE (`TRADING_PAIRS`) while the
internal config is camelCase (`tradingPairs`). `load.ts` normalizes keys before
parsing so the schema reads cleanly, then applies cross-field rules that zod
alone can't express (e.g. slow MA period must exceed fast).

## 3. `pino` for structured logging with redaction

**Decision:** `pino` emits structured JSON logs with secret redaction.

**Why:** JSON logs are machine-parseable for external tooling, and pino is
low-overhead. Redaction paths strip known secret keys (`apiSecret`, `token`,
authorization headers, etc.) automatically as a defense in depth.

**Important caveat:** redaction is defense-in-depth only. The application still
must never log secret values in the first place (e.g. by receiving them but not
printing them).

## 4. Paper mode is default; live trading is gated

**Decision:** `TRADING_MODE` defaults to `paper`. `live` requires both
`TRADING_MODE=live` **and** `REAL_FUNDS_AT_RISK=true`, otherwise startup fails.

**Why:** The most important safety property is that real money is never moved
by accident. Making live a deliberate, two-step opt-in dramatically reduces
the chance of a costly mistake. Paper and live will share an interface
(`ExecutionEngine`) but have entirely separate implementations.

## 5. Exchange adapters behind one interface; registry selects by name

**Decision (planned for Phase 3/4):** The engine depends only on `ExchangeAdapter`
and capability flags (`ExchangeCapabilities`). A `registry.ts` maps the config
string `EXCHANGE=ndax` to the concrete `NDAXAdapter`. Future exchanges are
added by implementing the interface and registering it — no engine changes.

**Why:** This enforces the requirement that the core is exchange-agnostic and
that NDAX-specific behavior stays isolated inside `src/exchanges/ndax/`.
Capability flags allow graceful handling of exchanges that don't support every
feature (e.g. no candles, no market orders).

## 6. Private credentials in environment only

**Decision:** API credentials are only read from the environment (via `.env`).
`.env` is git-ignored; `.env.example` documents variables with empty placeholders.

**Why:** Keeps secrets out of source and out of Git. A `.env` setup is the
lowest-friction path for the eventual non-technical user while still being
secure by default (file is never committed). A keychain/secret-manager path can
be added later without changing the config interface.

## 7. SQLite for persistence (planned Phase 9)

**Decision (planned):** Use embedded SQLite for persistence behind an abstract
repository layer.

**Why:** Zero-configuration, single-file, and synchronous (fits the bot's
single-threaded operation). The persistence is hidden behind repository
interfaces so it can be swapped later if needed (e.g. Postgres for multi-user).

## 8. Vitest for testing

**Decision:** `vitest` as the test runner.

**Why:** Native TypeScript, fast, built-in mocking, well-suited to a TS CLI
project. Test doubles/fakes (`tests/fakes/`) provide safe exchange interactions
so tests never place real trades.

## 9. Minimal dependencies

**Decision:** Keep runtime dependencies to `dotenv`, `pino`, `pino-pretty`, and
`zod`. Everything else is stdlib or dev-only.

**Why:** Fewer dependencies means a smaller attack surface and less maintenance.
We deliberately avoid a DI framework; plain constructor injection and small
interfaces are easier for another developer to follow.

## 10. NDAX `MinimumPrice` is a price floor, not a minimum order notional

**Decision:** The NDAX adapter does NOT map `MinimumPrice` into
`MarketInfo.minOrderQuote`.

**Why:** Live data (2026-08-28) shows `MinimumPrice = 25000` for `BTCCAD`. If we
treated that as a minimum order *value*, any order below $25,000 CAD would be
rejected — wrong. It is a per-instrument price *floor* (a collar/limit band, kept
well below market). `minOrderQuote` is reserved for a true minimum-order-value
rule. This is exactly the kind of assumption that must be validated against a
live API rather than trusted from a sample.

## 11. Polled REST market data (no WebSocket in Phase 5)

**Decision:** `LiveMarketData` polls the adapter's REST methods on a fixed
cadence; the NDAX adapter advertises `supportsWebSocket: false` until a real WS
client exists.

**Why:** NDAX is WS-primary, but building a WS client now adds substantial
complexity (frame parsing, auth, reconnection) before it is needed. For V1
(paper, low-frequency strategies on 1m+ candles) polling every 1–5s over public
data is sufficient and safe. The capability flag lets the engine and strategies
behave correctly regardless. The `MarketDataProvider` interface is intentionally
read-only and pull-based so a WS-backed provider can replace the polling one
transparently later.

## 12. NDAX candle timestamps use the exchange's end-time convention

**Decision:** `Candle.timestampMs` uses `DateTime` (row index 0), the candle's
END time, matching CCXT's NDAX `parseOHLCV`.

**Why:** The rest of the codebase may want open-time semantics, but matching the
established connector avoids an off-by-one surprise when cross-checking candles
against the platform UI. Callers are warned that the final candle can be
open-ended and that sparse markets return gap-y data.

## 13. Background polling never uses the 'error' event

**Decision:** `LiveMarketData` emits `failure` (not `error`) for poll failures.

**Why:** In Node, an `EventEmitter` 'error' event with no listener throws. A
transient network blip in a background poller must never crash the bot. Naming it
`failure` avoids the special-cased throw while keeping the semantic clear.
