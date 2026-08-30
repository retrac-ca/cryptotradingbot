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

## 7. Persistence — minimal JSON stores for Phases 8–9 (SQLite deferred)

**Decision (revised in Phase 9):** Persistence is two minimal JSON stores with
atomic temp-file+rename writes: `PaperStateStore` (the paper portfolio) and
`OrderStore` (the durable order ledger keyed by `clientOrderId`). Embedded
SQLite remains a possible future step but is **not** required for V1.

**Why:** Zero-configuration, single-file, and synchronous (fits the bot's
single-threaded operation). The stores are hidden behind small repository
classes so a later SQLite/Postgres backend can be swapped in without changing
callers. For V1's scope (restart-safe paper portfolio + duplicate-order-proof
order ledger + reconciliation), JSON is sufficient, honest, and auditable.

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

## 14. The RiskManager sizes orders and enforces all account limits

**Decision:** Risk lives in `src/risk/RiskManager`. It sits between `Signal` and
execution. It does not just approve/reject — it computes the permitted order
size from a read-only `RiskContext` snapshot. Strategies never choose a size.
Every decision carries a typed reason code (not just a free-form string) plus
the quantity, estimated notional, and the limits that applied.

**Why:** The spec required that a strategy cannot bypass risk controls by
arbitrarily choosing a position size, and that decisions be auditable. Types
like `DAILY_LOSS_LIMIT_EXCEEDED` are stable keys for logs/persistence/debugging.

**Fail-closed:** whenever a required input is missing or stale (unknown balance,
position, portfolio value, exposure, P&L, market info, price; or stale market
data), the BUY path rejects rather than guessing. No "critical-risk-calculation
unavailable" case silently trades.

**How risk-reducing SELL is handled:** A SELL that closes/reduces a long is
exempt from the exposure-affecting gates (daily loss, drawdown, cooldown,
position/exposure/trade caps) — those are about *new exposure*. But it still
validates the order itself (market info, price, position, quantity) and is
long-only: a SELL is sized to at most the held position and is rejected if there
is nothing to sell or it would go short. Stale-data/unknown-state still fail
closed for SELL because we must not size from an unreliable price.

## 15. No separate `Quantity` type; Money covers asset quantities

**Decision:** Asset quantities are represented with the same `Money` type as
prices/notional, rather than introducing a distinct `Quantity` class. Three
exact BigInt methods were added to `Money` to support risk math: `mul`
(quantity × price → notional), `div` (notional ÷ price → quantity), and
`floorToIncrement` (round down to a tick so a sized quantity never exceeds the
cap that produced it).

**Why:** `Money` is already fixed-point scale 8 (covers BTC's 8-decimal
precision), immutable, and supports tick-multiple validation
(`isMultipleOf`) and rounding (`roundToIncrement`). A separate `Quantity` class
would duplicate ~200 lines of identical BigInt arithmetic for no V1 benefit;
exchange precision is enforced instead by validating against
`MarketInfo.quantityTick`/`priceTick` before returning an order. This keeps the
"no floating-point for money/quantities" invariant while avoiding needless
duplication.

## 16. Paper execution is a local simulator with no live-execution path

**Decision (Phase 8):** Paper trading is implemented by `PaperExecutionEngine` —
a self-contained simulator that fills orders against a provided reference price
with configurable fees, slippage, and fill fraction, and updates the `Portfolio`.
It holds **no reference** to any exchange adapter and exposes **no** path that
submits a real order. Paper fills record reason codes (e.g. `"test"`) instead
of exchange order ids, and a test asserts `placeOrder`/`cancelOrder` are never
invoked while the engine trades — proving paper cannot route to NDAX (or any
live) order placement.

**Simulator assumptions (kept intentionally simple):**
- Market orders fill fully (or by `fillFraction`) at the reference price
  adjusted by a slippage fraction (`paperSlippageFraction`).
- Limit orders fill immediately when marketable (BUY limit ≥ ask, SELL limit ≤
  bid); otherwise they rest `OPEN` and can be cancelled. They can partial-fill by
  `fillFraction`.
- Fees are charged as a fraction of notional (`paperFeeFraction`) in the quote
  currency. 0 disables the respective effect.
- Long-only V1: a SELL cannot exceed the held position (the risk layer sizes
  it; this engine re-validates as a safety net).
- No order book depth, queue position, or partial-limit-then-rest simulation
  beyond the above — that level of realism belongs to Phase 10 backtesting.

**Why:** The goal of Phase 8 is a continuously-running, restart-safe, end-to-end
paper bot that exercises the real strategy/risk pipeline against real market
data. Full order-book microstructure is unnecessary and would over-engineer the
phase. Because execution is purely local and portfolio math is exact `Money`,
paper results are deterministic and auditable, and the same order/portfolio
types carry forward to live execution.

## 17. Restart-safe minimal JSON state (full persistence deferred to Phase 9)

**Decision (Phase 8):** `PaperStateStore` persists the `PortfolioModel` plus the
list of executed paper order ids to a single JSON file using an atomic
temp-file+rename write. On start, `buildEngine()` loads it and rebuilds the
`Portfolio`, so a restart does not reset cash, positions, P&L, realize duplicate
flats, or forget executed orders.

**Why:** Only this small set is needed to stop the paper bot from "forgetting"
its book across restarts. A full SQLite repository with order/trade history and
reconciliation is Phase 9; JSON is sufficient and honest for Phase 8's scope.
`Money` is stored as its canonical decimal string so values survive exactly.

## 18. Durable order ledger keyed by `clientOrderId` (duplicate-order prevention)

**Decision (Phase 9):** `OrderStore` (`src/persistence/OrderStore.ts`) persists
every order the bot attempts in `.order-ledger.json`, keyed by its local
`clientOrderId`, with the order **written as `CREATED` before any network call**
(persist-before-submit).

**Why:** No matter what happens (crash, timeout, restart), a fresh process can
look up whether an order with a given key was already attempted. The
`LiveOrderEngine` refuses to re-submit an existing `clientOrderId`, so a retry
can never create a duplicate real order — the #1 live-trading hazard. Money
values are stored as decimal strings (exact) rather than BigInt, so JSON
serialization is lossless.

## 19. Reconciliation — the exchange is authoritative; fail closed

**Decision (Phase 9):** `ReconcileService` fetches the exchange's account state
(balances, open orders, order history) via the `ExchangeAdapter` and
`Reconciler` compares it against the bot's local ledger. Discrepancies
(`LOCAL_OPEN_MISSING_ON_EXCHANGE`, status mismatch, unknown exchange orders,
negative balances) make the account `safeToTrade=false`. If any read fails, the
snapshot is treated as incomplete and the report fails closed
(`CANNOT_DETERMINE`).

**Why:** In live trading the exchange is the source of truth. The bot never
"fixes" a mismatch by guessing (e.g. never blind-resubmits an order it believes
is open but the exchange no longer shows). Reconciliation is read-only
(`bot reconcile`) and must pass before new orders are considered safe. This is
the safety loop referenced by the "reconcile before retry" rule.

## 20. Live execution engine — gated, fail-closed, no-auto-retry

**Decision (Phase 9):** `LiveOrderEngine` is exchange-agnostic and enforces hard
safety properties:
1. **Gated start** — refuses to operate unless `tradingMode=live` **and**
   `realFundsAtRisk=true` **and** the adapter declares `supportsOrderPlacement`
   **and** no kill switch.
2. **Persist-before-submit** — records the order as `CREATED` before any network
   call (see §18); a pre-existing key yields a defensive duplicate rejection.
3. **No auto-retry on ambiguous outcomes** — a timeout / network / invalid
   response / unknown submission marks the order `UNKNOWN` (no retry); the caller
   must reconcile with the exchange before any action. Only a **definite**
   rejection (`OrderRejectedError`) is treated as non-ambiguous.
4. **Precision & balance validation** — quantity and limit price are checked
   against the market's tick grid, minimum order size, and the live available
   balance before submission; anything off-grid or unaffordable is rejected
   without touching the exchange.

**Why:** The error hierarchy in `src/exchanges/errors.ts` distinguishes
AMBIGUOUS (may have reached the exchange → must reconcile) from DEFINITE
(safe to treat as failed). The engine leans on that distinction so the rule
"never blindly re-submit an order whose outcome is unknown" is enforced in code,
not by convention. Because NDAX order placement is not yet live-verified, the
engine is proven against the `ExchangeAdapter` interface (via `FakeExchange`),
and NDAX itself keeps `supportsOrderPlacement=false` so live mode fails closed.

## 21. Backtesting — historical simulation, explicit simplifications

**Decision (Phase 9):** `BacktestRunner` replays candles through the **real**
strategy → risk → execution pipeline (the same `Strategy` and `RiskManager`
used live), with simulated execution filled at each candle's close plus
configurable fee and slippage fractions. `computeMetrics` reports the required
set: starting/ending capital, total return, trade count, winning/losing trades
and win rate, realized P&L, fees, max drawdown, and largest win/loss.

**Why:** Reusing the live strategy/risk classes means the backtest measures the
actual system, not a parallel approximation. Documented simplifications: fills
execute the full requested quantity at the close price (no partial fills,
no intra-candle price path), and a synthetic `MarketInfo` supplies the tick
grid (price tick 0.01, quantity tick 1e-8, flat 0.2% fee). Results are labeled a
**historical simulation, not a prediction of future performance** — and the CLI
prints that warning on every run.
