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

## 22. NDAX private order placement — documentation + isolation milestone (V1)

**Decision (Phase 9 follow-up, 2026-08-29):** Live NDAX order placement stays
**disabled** (`supportsOrderPlacement=false`, `placeOrder`/`cancelOrder` throw
`OrderRejectedError`). What was produced instead is a precise, evidence-backed
map of NDAX's private trading API plus a pure, unit-tested order-mapping layer
(`src/exchanges/ndax/orderMappings.ts`) that encodes the documented SendOrder /
CancelOrder request + response shapes — **not wired to any network call**.

**Verified from the current official apidoc.ndax.io (v3.3):** SendOrder is a
POST, ASYNCHRONOUS, returning only `{status:"Accepted"/"Rejected", OrderId}` —
an ack is not an on-book confirmation, so reconciliation is mandatory. CancelOrder
is a POST, synchronous, and its `{result,...}` response confirms only
**receipt**, not cancellation — confirm via GetOrderStatus/GetOpenOrders.
NDAX `ClientOrderId` is a long integer and is **not** documented as a uniqueness
/idempotency key (the CancelOrder doc warns it "may not be unique").

**Why (safety):** This directly confirms our V1 engine's design: the local
OrderStore (persist-before-submit) plus "reconcile before retry" — NOT NDAX's
`ClientOrderId` — is the duplicate-order protection. Enabling placement also
cannot be tested on any NDAX-provided mechanism (no official public testnet;
the staging host is third-party/conflicting), so **no SendOrder/CancelOrder call
was or can safely be made without risking real funds**, per the late-2026 rules.
The mappers are left ready-to-wire and covered by deterministic-fixture tests;
the `NDAX_API.md` "what is required before supportsOrderPlacement can become
true" checklist enumerates the six items (live read auth, a safe placement
mechanism, wire-shape verification, lifecycle confirmation, key/IP permissions,
fees) that must pass first.

## 23. V1 live-enablement hardening — risk-gated execution + balance reconciliation (2026-08-29)

**Decision (V1 hardening, no live trading enabled):** three gaps in the
live-ready software path were closed, with **no** change to
`supportsOrderPlacement` (still `false`), **no** wiring of NDAX into real order
submission, and **no** live order/cancel calls.

1. **`LiveOrderEngine.place` now takes a `RiskContext` + intent instead of a raw
   `NewOrder`.** It runs the owned `RiskManager`; the order (side, quantity,
   internally-generated `clientOrderId`) is built **only** from the risk approval,
   so a strategy cannot bypass portfolio-level risk or dictate size. A risk
   rejection returns `REJECTED` without ever contacting the exchange. The
   strategy→risk→live-engine→store→adapter path is the single entry point.
2. **Local-vs-exchange balance reconciliation.** `Reconciler.reconcile` and
   `ReconcileService.reconcile` accept `ReconcileOptions.expectedBalances`
   (currency → expected local available) plus a `balanceTolerance` (default one
   unit of `Money` scale, i.e. effectively exact). An unexplained difference
   beyond tolerance, or an expected currency missing from the exchange, yields a
   `BALANCE_MISMATCH` discrepancy and forces `safeToTrade=false`. The local
   balance is never silently overwritten with the exchange's — the mismatch is
   surfaced for a human/engine to resolve.

**Why:** these close the V1 safety-critical test/design gaps: (a) the previous
entry point let a caller hand the engine an arbitrary order, so RiskManager was
not structurally in the live path; (b) reconciliation previously compared only
orders, not balances, so unexplained balance drift wouldn't stop trading; (c) the
below-min-size, limit-notional, limit-tick, SELL-over-balance, catch-all-UNKNOWN
and ack-timeout gates were untested. All are now unit-tested. See the three-phase
framing (software readiness vs NDAX private-API verification vs live-trading
authorization) in `NDAX_API.md`.

## 24. NDAX order-placement network paths — implemented but stay disabled (Gate 3, 2026-08-30)

**Decision (Gate 3):** `NdaxAdapter.placeOrder()`/`cancelOrder()` now implement
the **real SendOrder/CancelOrder network paths**: signed POST JSON bodies via the
existing `NdaxRestClient` (same auth headers, throttle, and typed error mapping
as every other call — no second HTTP implementation), composed from the pure
`orderMappings.ts` layer (`toNdaxSendOrderRequest`/`toNdaxCancelOrderRequest`/
`mapSendOrderResponse`/`mapCancelOrderResponse`). The paths are gated behind an
internal `enableOrderPlacement` option that defaults to `false` and is **NOT
reachable from any configuration**, and `capabilities.supportsOrderPlacement`
stays `false` — so `LiveOrderEngine` refuses to construct and live trading
remains impossible. `mapSendOrderResponse` now also **fails closed**: any ack
without a recognized `"Accepted"`/`"Rejected"` status throws
`InvalidResponseError` (AMBIGUOUS), so a malformed SendOrder response can never
be mistaken for a definite acknowledgement.

**Why:** Gate 3 builds the reviewed, deterministic, tested pathway for a future
Gate that arms live trading: exact wire behavior is proven against scripted
fetches, not guessed. Mirroring the existing `enableAuthenticatedReads` pattern
lets tests exercise the full network path while nothing in production can turn it
on, and the engine still keys off `supportsOrderPlacement` (the sole capability
gate), which remains `false`. NDAX SendOrder is **asynchronous** (an ack is NOT
an on-book confirmation) and CancelOrder's ack is **receipt-only**, so lifecycle
is still confirmed via GetOrderStatus/GetOpenOrders reconciliation — unchanged
from §19/§20. A redundant explicit mechanism was added for live start:
`bot start` requires `TRADING_MODE=live` + `REAL_FUNDS_AT_RISK=true` **and** the
per-invocation `--confirm-live` flag before it will even consider live mode, and
then verifies the adapter's `supportsOrderPlacement` capability.

**Alternatives rejected:** (a) flipping `supportsOrderPlacement=true` now —
rejected, that is the explicit human Gate-4 review decision per the checklist in
`NDAX_API.md`; (b) a second HTTP/private client — rejected, reuse
`NdaxRestClient`; (c) relying on NDAX `ClientOrderId` as an idempotency key —
rejected, NDAX documents it "may not be unique" so our persist-before-submit
OrderStore plus reconcile-before-retry remains the duplicate protection; (d)
letting live mode "start" without the confirmation flag — rejected, the flag is
the required human acknowledgement in front of any future live start.

## 25. Hybrid market-data freshness + one-shot `live-test` (Gate 4, 2026-08-30)

**Decision (Gate 4):** Market-data "fresh enough to risk money on" is now checked
as **two independent dimensions** and both must pass or the decision fails closed
as `STALE_MARKET_DATA`:

1. **QUOTE** — the exchange-reported quote time (NDAX L1 `TimeStamp`, or the
   newest L2 `ActionDateTime`). Bounded by `marketDataMaxAgeMs` (default 60s).
2. **TRANSPORT** — the local wall-clock time the snapshot was actually
   fetched/observed (stamped by `LiveMarketData` and exposed as
   `marketDataObservedAtMs`). Bounded by `marketDataTransportMaxAgeMs` (default
   60s).

A freshly-fetched snapshot can still be built on a stale quote, and a fresh quote
can have been fetched long ago — so both are required. Clock skew is handled
explicitly: NDAX timestamps can sit ahead of local time, so a bounded
`maxClockSkewMs` (default 120s) rejects `QUOTE_AHEAD_OF_CLOCK`. This is a
future-dating **guard**, NOT a widening of the stale threshold — `maxQuoteAgeMs`
is left untouched. Pure logic lives in `src/marketdata/freshness.ts`
(`evaluateFreshness`, `newestQuoteTimestampMs`) and is shared by the RiskManager
and the new command so there is one source of truth.

The bounded **partial SELL** is the only place an operator may influence size:
`RiskContext.sellTarget` (a `fraction` and/or `notional` cap) makes a SELL a
partial exit, but the approved quantity is always `min(held position, target)`,
floored to the quantity tick — an operator can NEVER inject an arbitrary raw
quantity, and a malformed target (`INVALID_SELL_TARGET`) fails closed. A BUY
ignores `sellTarget`; an absent target still means a full exit.

A new one-shot `bot live-test sell [--target-cad <N>] [--confirm-live]` command
wires the real live path end-to-end for a single, deliberate, risk-sized SELL
(the sanctioned safe-first live order). It refuses **before any exchange contact**
if any gate fails (live mode, realFundsAtRisk, kill switch off, `--confirm-live`,
authenticated reads on, exactly one pair, adapter supports order placement), then
fetches the snapshot, reconciles (must be safe-to-trade), runs the RiskManager,
prints a fully-disclosed summary, asks for `EXECUTE`, and places **one** order. On
an ambiguous outcome (timeout/unknown) it NEVER retries — it reconciles and exits
non-zero. `ACK != FILLED`: after an ack it confirms via authoritative order state
and reconciles; a failed confirmation does not claim success.

**Why:** the stale-only check treated "how old is the quote" as sufficient, but
the verified NDAX candle boundary (~60s ahead) and the possibility of a late
transport make a single-dimension check unsafe. The `live-test` command gives a
human a single controlled lever to validate the live path and the NDAX private
API (Gate 3 review) with a risk-reducing SELL, without enabling continuous
autonomous live trading — which stays behind the explicit Gate-4 human review
decision in `NDAX_API.md`.

**Alternatives rejected:** (a) auto-retrying an ambiguous live order — rejected,
this is the cardinal safety rule (§19); (b) accepting a raw `--quantity` in
`live-test` — rejected, operators must not inject arbitrary fills, only a bounded
CAD notional; (c) silently tolerating any forward-dated quote — rejected, that
would let a skewed clock bypass freshness; (d) adding `live-test` as a sub-step of
`bot start` — rejected, keep the risky path small, explicit, and single-shot.


## 26. Portfolio ownership + multi-asset selection (Gate 5, 2026-08-31)

**Decision:** exchange balances are NOT implicitly bot-owned. The bot distinguishes
**external** holdings (present before/outside the bot) from **bot-managed**
holdings (created by the bot, or an external asset the user explicitly authorized).
The central invariant:

> External assets are external unless explicitly authorized. Bot-created assets
> are bot-managed. The bot may only SELL bot-managed inventory and may only BUY
> using deployable quote assigned to it.

This is generic for any account (not a special case for one user's BTC), because
every concept is expressed in terms of the bot's own managed state.

**Ownership model.** `Portfolio` became a **managed portfolio**:
- `positions` (with `source: 'BOT' | 'EXTERNAL_AUTHORIZED'`) — bot-managed only.
- `externalSnapshot` — assets recorded at onboarding, not tradable.
- `authorizedExternal` — symbols the user explicitly opted into management.
- `reserved` — quote committed to in-flight bot orders (deployable = cash − reserved).
- `managedOpenCount()` / `atMaxOpenPositions()` — managed-only, external ignored.
- `expectedAssetBalances()` — managed + external by base asset, for reconciliation.

**Why external holdings never block unrelated assets.** Risk denominators
(`portfolioValue`, `portfolioExposure`, `currentPosition`) are computed from the
**bot-managed** portfolio, NOT the exchange total. So a $10k external BTC neither
inflates the managed-equity denominator nor consumes the per-asset position cap;
the bot can still buy ETH with its deployable CAD. Equally, the strategy and risk
see managed quantity only, so an account holding pre-existing BTC is treated as
**flat** for BTC — and a SELL of BTC is rejected unless there is managed BTC.

**SELL ownership.** `RiskContext.currentPosition` is the MANAGED quantity. A SELL
can never consume external inventory: a SELL with managed = 0 but external > 0 is
rejected with the new reason `SELL_EXCEEDS_MANAGED_POSITION`. The Gate-4 bounded
`sellTarget` is unchanged but its ceiling is now managed inventory.

**Deployable quote & fee reservation.** BUY funding now requires
`notional + estimated taker fee <= deployableQuote`, where
`deployableQuote = available cash − reserved`. The bot can no longer approve a
BUY that spends the balance but forgets the fee.

**Multi-asset universe & coordinator.** A curated `UNIVERSE_MARKETS` default
(`BTC/CAD,ETH/CAD,SOL/CAD,XRP/CAD,ADA/CAD`) replaces blind coverage of all 80+
NDAX CAD markets. `buildUniverse` filters by eligibility (quote currency, valid
ticks, min order, fees, market orders) using exchange metadata only (never the
unreliable `BidOrderCt`/`AskOrderCt`). A new `MarketCoordinator` evaluates every
eligible market, records risk-approved opportunities, and executes **at most one
trade per cycle** via a deterministic ranking: (1) risk-approved SELL exits take
precedence over BUYs (exit before entry), then (2) BUYs by lower relative spread,
then symbol — a testable, non-arbitrary order.

**Risk scopes.** `maxOpenPositions` is now enforced (RiskManager, via
`openManagedPositionCount`); external holdings never count toward it. `stopLoss`
/`takeProfit` remain parsed but are documented as NOT enforced (no false
protection). `MarketCoordinator` never manufactures signals, never bypasses
RiskManager, and never forces a BUY — **NO TRADE is a correct, expected result**.

**Reconciliation.** Ownership-aware: expected exchange balances are derived from
managed + external; an unexplained gain/loss (deposit, manual trade, withdrawal)
is surfaced as a `BALANCE_MISMATCH` discrepancy and never auto-adopted or
auto-transfer. `expectedBalances` is now wired into the live-test and `reconcile`
paths. Unknown/ambiguous bot orders keep `safeToTrade = false`.

**Live remains disabled.** `supportsOrderPlacement` is still `false`; no
`SendOrder`/`CancelOrder` can occur. `live-test sell` now operates against the
managed portfolio (its SELL is bounded by managed inventory only) but cannot be
executed in Gate 5. Real trading, and the first real trade, await Gate 6 (after
portfolio ownership, multi-asset selection, and safe NDAX order-path verification).

**Alternatives rejected:** (a) treating all exchange assets as bot-managed on
onboarding — rejected, silently seizes user crypto; (b) blocking selling external
only by convention — rejected, the ownership check must be structural; (c)
"sizing" by total account equity — rejected, external holdings would inflate the
denominator and mis-size/mis-block; (d) trading every listed market — rejected,
would auto-trade illiquid meme coins; (e) inventing a scoring system — rejected,
deterministic spread + symbol ranking is testable and sufficient for V1; (f)
forcing a first trade when no signal exists — rejected, NO TRADE is the safe,
correct outcome.

## 27. F-1 — separate paper vs live managed state (2026-08-31)

Audit finding F-1: `bot live-test` loaded its "live managed portfolio" from
`PAPER_STATE_FILE`, so a paper position could masquerade as a live-managed one.

**Decision:** paper and live managed state are now *physically separate*:
- Paper: `PAPER_STATE_FILE` (`.paper-state.json`) — used only by the paper
  engine, and its composition root.
- Live: `LIVE_MANAGED_STATE_FILE` (`.live-managed-state.json`) — a dedicated
  `ManagedStateStore`, used only by `live-test` and `reconcile`.

They reuse the same `Portfolio` serialization format but never the same file,
store instance, or load path. `validateConfig` refuses to run if the two paths
are identical. If the live store is absent/unreadable, the live path returns an
EMPTY managed portfolio (no managed positions, no deployable capital) — it never
falls back to paper state and never adopts exchange balances. `bot live-test`
and `bot reconcile` now read only the live store; `bot status` / paper engine
remain on the paper store.

## 28. F-3 + F-4 — fail-closed timestamps & execution-time freshness (2026-08-31)

Audit findings F-3 and F-4.

**F-3 (L1 timestamp fail-open):** `mapLevel1ToTicker` previously did
`timestampMs: Number(r.timestamp ?? r.lasttradetime ?? Date.now())`, so a missing
NDAX timestamp manufactured a local "fresh" time. Now `Ticker.timestampMs` is
`number | null` and missing/malformed/zero/negative/non-numeric exchange
timestamps map to `null` (via `exchangeEpochMs`), never a fabricated `Date.now()`.
Freshness then fails closed (`QUOTE_MISSING`).

**F-4 (freshness TOCTOU):** `live-test` captured `nowMs` once and reused it after
the operator typed EXECUTE, so freshness was validated at snapshot time, not
execution time. Now, after an operator confirms, live-test re-fetches a FRESH
snapshot (`fetchLiveSnapshot`) at `Date.now()`/injected clock, rebuilds the
RiskContext with a fresh `nowMs`/observation time, and passes that to
`LiveOrderEngine.place`, which re-runs RiskManager against it immediately before
submission. An arbitrary operator delay can no longer let a stale or
missing-timestamp snapshot pass the final risk gate; the result is NO ORDER.

**F-8 (localized):** the final freshness basis is the L1 ticker timestamp — the
actual price source for the order — not a possibly-newer unrelated L2 timestamp,
so an L1 stale/missing value is never declared fresh because L2 happened to be
newer. The broader F-8 redesign remains out of scope.

The paper path is unchanged; `supportsOrderPlacement` remains `false`.

## 29. F-3 extension — eliminate remaining exchange-time `Date.now()` fallbacks (2026-08-31)

The Gate 5.2 audit found two more places where a local clock could masquerade as
an exchange timestamp:

1. **Order/fill timestamps** (`mapOrder`): fill `timestampMs` fell back to
   `Date.now()` and `createdAtMs`/`updatedAtMs` fell back to `Date.now()`. Now
   `Fill.timestampMs`, `Order.createdAtMs` and `Order.updatedAtMs` are `number |
   null`: a missing exchange time is `null` (unknown), never fabricated.
   Downstream `trades` sorting handles `null` (unknowns sort first); locally-created
   bot orders retain their genuine application time.
2. **OrderBook timestamp** (`NdaxAdapter.getOrderBook` passed `Date.now()` into
   `mapL2ToOrderBook`'s `timestampMs`). Now `OrderBook.timestampMs` is the
   **exchange** quote time (newest L2 `ActionDateTime`) or `null` — never a local
   time. The distinction is unambiguous:
   - `timestampMs` / `quoteTimestampMs` = exchange quote time (or null);
   - `observedAtMs` = local observation/transport time (stamped by LiveMarketData).

The invariant holds everywhere: an unknown exchange time is UNKNOWN/fail-closed,
never a locally fabricated timestamp. The remaining `Date.now()`/`new Date()` uses
in the NDAX path are legitimate local application/observation time (health
latency, nonces, candle-query bounds, marked-to-local `observedAtMs`, engine
"now", throttle timing). `supportsOrderPlacement` remains `false`.

## 30. F-2 — coordinator pricing must account for ALL managed positions (2026-08-31)

The Gate 5 adversarial audit found a HIGH risk-control regression: the
`MarketCoordinator` built a `priceMap` containing only the symbol currently being
evaluated, so `Portfolio.markToMarket`/`exposure` silently omitted every OTHER
managed position (both functions `continue` when they find no price). With several
managed positions, the exposure cap could be under-counted and a new BUY sized
beyond the configured `maxPortfolioExposureFraction`.

**Fix:** `MarketCoordinator.buildRiskContext` now builds a COMPLETE portfolio-wide
price map:
1. the candidate symbol's own price (whose freshness RiskManager validates), plus
2. every OTHER existing managed position, valued from the polled market-data cache
   (`getTicker`, no extra exchange calls, no `Date.now()` substitution).

If a managed position cannot be valued (no ticker available), the risk context is
built with `portfolioValue`/`portfolioExposure`/`unrealizedPnlToday` = `null`, so
the RiskManager fails closed (`UNKNOWN_PORTFOLIO_VALUE` / `UNKNOWN_EXPOSURE`) and
no order is approved — it is never silently treated as zero. External holdings
remain excluded (they live in `externalSnapshot`, never in `positions`). SELLs are
unaffected (risk-reducing; they don't read exposure/equity), so exits are never
blocked by a temporarily unpriceable position. This restores the pre-Gate-5
behavior where `PaperEngine` priced the whole symbol set.

`supportsOrderPlacement` remains `false`.

## 31. C-2 — paper execution must never overdraw quote cash (Gate 6.2, 2026-09-02)

The Gate 6 adversarial audit flagged that `PaperExecutionEngine` fills a BUY at
the reference price adjusted for positive `paperSlippageFraction`, while
`RiskManager` pre-approves a BUY against the *reference* price. For a
near-full-deployment BUY, the true fill cost (`fillQty × fillPrice + fee`) can
exceed what the funding check allowed, driving paper cash negative — reproduced:
`$1000` cash, BUY `0.025` BTC @ `40000`, fee `0.05%`, slippage `0.05%` → cash
`-1.00025`.

**Decision:** enforce the accounting invariant at the **execution boundary**, in
`PaperExecutionEngine`, not in `RiskManager` and not in `Portfolio.applyFill`:

- Before mutating any state, a BUY whose actual slippage-adjusted cost exceeds
  the currently-deployable quote (`cash − reserved`) is **REJECTED** (a
  `REJECTED` paper order, untouched portfolio). This mirrors the existing
  integrity rejection (e.g. SELL-exceeds-position) and the live
  balance-revalidation contract (§20).
- Guards both fill paths: `submitMarketOrder` and marketable `submitLimitOrder`.
- `fillPrice`, `fillQty`, `fee`, and the cost are compared **exactly** with the
  real `Money` used by `applyFill`, so there is no order-of-magnitude mismatch
  and no silent overdraw.

**Why this is the minimum safe correction, and not the alternatives:**
- *Risk/funding accounts for slippage* — rejected: couples the exchange-agnostic
  risk layer to a paper-only simulation parameter, and would leak paper
  semantics into the funding model.
- *Clamp `cash = Math.max(0, cash)`* — rejected: hides the accounting error and
  manufactures conservation instead of refusing an impossible fill.
- *Silently reduce the filled quantity* — rejected: changes the documented
  fill-at-reference price contract without declaring it.
- *Guard inside `Portfolio.applyFill`* — rejected: `applyFill` is a pure
  lower-level accounting primitive (also reused by `BacktestRunner`); the
  **execution** engine is the component that owns slippage/fees and therefore the
  cost-vs-funds decision. The paper fill path is fully covered because
  `PaperEngine` only ever calls `submitMarketOrder`, and both `applyFill` calls
  are guarded.

**Invariant now guaranteed for the paper path:** `quote cash ≥ 0` after every
fill, reserved funds are never spent (cost is bounded by `deployableQuote`, not
raw cash), and a fill either completes honestly (real slippage + fee) or is
refused — never partially-manufactured. `supportsOrderPlacement` remains `false`;
no SendOrder/CancelOrder, no live BUY loop, no `.env` change.

## 32. Gate 9 — manual-execution bridge hardening (operator-executed, order-level, fail-closed) (2026-09-03)

**Context.** Gate 9 adds a manual-execution bridge: RETRAC *recommends* a trade
(evaluated by the normal RiskManager), the **operator** executes it EXTERNALLY on
the exchange's authoritative interface, and RETRAC records evidence, validates it
against an authoritative exchange read, and **accounts the result at the ORDER
level**. The manual path was paused before building a CLI so its core accounting
path could be adversarially audited first. This entry records the hardening
enforced before any CLI is built on top.

**Fundamental posture.**
- **RETRAC never submits or cancels an order.** The bridge only reads via
  `adapter.getOrderStatus`; `placeOrder`/`cancelOrder` are never called on the
  manual path. `NdaxAdapter.capabilities.supportsOrderPlacement` remains `false`.
  **No `SendOrder`/`CancelOrder` and no autonomous live BUY loop is introduced.**
- **Order-level accounting is deliberately separate from execution-level live
  accounting.** `Portfolio.settleManualOrder` is the manual primitive; it is NOT
  `applyLiveFill` and never routes through it. It is keyed by the LOCAL
  `intentId` and accounts the ORDER AGGREGATE (final filled quantity × average
  price + total fee) once.
- **No execution identity is fabricated.** NDAX's documented/verified surface
  provides no trustworthy per-execution identity (and its `ClientOrderId` is
  a long integer that "may not be unique"). The manual path therefore NEVER
  manufactures an execution id and NEVER treats an exchange `OrderId` as one.
  It makes NO claim of exactly-once per-fill accounting for manual orders, NO
  exchange-side idempotency, and NO unique ClientOrderId.

**Evidence authority.** Operator-entered evidence (`ManualEvidence`) is a HINT,
never authoritative. Authority comes only from an exchange `getOrderStatus`
read. `evidenceSource` records where the operator claimed it came from, but that
does NOT upgrade it to authoritative.

**Field provenance (used during settlement).** For every field:
- `filledQuantity`, `averagePrice`, `status`, `quantity` (requested), `type`,
  `price` (limit), `createdAtMs`/`updatedAtMs`, `fee`, `feeCurrency`,
  `exchangeOrderId` — AUTHORITATIVE exchange data (from the order-status read);
  `feeCurrency` is currently hardcoded `'quote'` in NDAX `mapOrder` and is an
  UNVERIFIED assumption (documented limitation).
- `ManualEvidence.orderId/status/filledQuantity/averagePrice/fee/feeCurrency/
  evidenceSource` — OPERATOR ASSERTION (hint), only accepted when it AGREES with
  the authoritative read; never upgraded to authoritative just because it matches
  structurally.
- intent `quantity`/`limitPrice`/`type` — the risk-approved proposal (local).
- settlement `fee` — AUTHORITATIVE (quote) only; never derived/modelled.
- `executedAtMs` (ManualSettlement) — authoritative `updatedAtMs` (local fallback
  only for the risk snapshot's `marketDataObservedAtMs`, which is a local audit
  field, not an exchange timestamp).

**OrderId → intent binding (do not "own" an OrderId just because it was typed).**
`bindOrderToIntent` is the strongest binding actually supported by authoritative
exchange data:
- required: `symbol` and `side` match the intent;
- STRONG factor (≥1 must be established): requested/original quantity equals the
  proposed quantity (and fill ≤ requested); or `createdAtMs ≥ intent.createdAtMs`
  (an order created before the proposal is provably UNRELATED); or, for a limit
  intent, exchange type == limit AND exchange limit price == intended limit;
- a fill exceeding the proposed quantity is impossible → reject.
If NO strong factor can be established (all authoritative fields null/absent),
the binding FAILS CLOSED — the order is NOT automatically attributable to the
intent and the operator must reconcile it outside the automatic accounting path.
We never fall back to a symbol+qty+price+time "sameness" heuristic.

**Fee semantics.** Only an AUTHORITATIVE, quote-denominated exchange fee is used
for accounting. A base-denominated fee is REJECTED (no safe, exchange-confirmed
conversion; we never silently reinterpret a base fee as quote). The absence of an
authoritative fee FAILS CLOSED — we never use an operator-reported or modelled
fee as authoritative (that would let an operator under-account cost / inflate
proceeds — an accounting backdoor). NOTE: the current NDAX `mapOrder` hardcodes
`Order.feeCurrency = 'quote'`; until that assumption is verified against a live
account, manual settlement requires an authoritative fee and will fail closed if
NDAX reports none.

**Reservation (BUY) semantics.** A BUY settlement REQUIRES an ACTIVE order-linked
reservation keyed by the intent id (created at proposal). The actual aggregate
cost must be ≤ the reserved amount; an under-reservation FAILS CLOSED (the
reservation is never over-consumed, and nothing mutates on the thrown path). On
settlement the reservation is consumed by the cost and then released EXACTLY once
so the leftover (reserved − cost) returns to the deployable pool; the
`manualSettlements` ledger (keyed by intent id) guards exactly-once and reject
conflicting repeats.

**SELL ownership.** A manual SELL may only sell BOT-managed inventory
(`positions`, `source: BOT | EXTERNAL_AUTHORIZED` — both are bot-managed once
authorized). External/non-authorized inventory (`externalSnapshot`) is NEVER
consumed: the proposal checks the managed position, and `applyFill` refuses a
SELL larger than the held managed position, so a settle can never create an
impossible negative managed position.

**State machine.** `PROPOSED → CONFIRMED → EVIDENCE_RECORDED → SETTLED`;
`PROPOSED/CONFIRMED/EVIDENCE_RECORDED → CANCELED`; terminal states never regress.
Evidence cannot be recorded without prior confirmation, cannot be recorded after
a terminal state, and a terminal record is never overwritten by a different
terminal state nor regressed to open. `CANCELED` (no-fill) releases a reservation
exactly once; `AMBIGUOUS` never silently releases a reservation (and cannot be
canceled without first recording authoritative evidence or reconciling). `VOID`
exists as a status but is not reachable automatically.

**Crash/recovery (two non-atomic stores).** The portfolio state and the
manual-intent store are separate atomic files — there is NO cross-file atomicity.
`ManualTradeBridge.reconcile` makes the state machine recoverable: it DETECTS
orphan reservations (portfolio only), missing BUY reservations (intent only), a
portfolio settlement without a SETTLED intent status, and an intent SETTLED with
no recorded settlement. It deterministically REPAIRS only the safe cases:
finalize an intent whose settlement is already recorded (no fill fabricated), and
release a leak in a terminal NO-FILL intent (no positive fill evidence). It NEVER
auto-releases a reservation where a positive external execution may exist and
NEVER fabricates a fill; anything else is reported and `safeToTrade = false`.

**ManualIntentStore durability.** `load()` returns `null` ONLY when the file is
absent (fresh). Malformed JSON, unsupported version, missing `intents`, malformed
intent/money/status/field values, truncated files, or a leftover `.tmp` sibling
all THROW `CorruptManualIntentStoreError` — a corrupted store is never silently
read as "no intents" (which could hide active reservations or unresolved
executions).

**What remains impossible / prevents automated live BUY readiness.** The manual
path cannot prove exactly-once exchange execution, cannot attribute an OrderId to
an intent when the exchange provides no strong binding factor, cannot confirm
order fees when NDAX does not report them (or reports them in base), and cannot
recover an ambiguous order automatically. `supportsOrderPlacement` remains
`false`; there is no SendOrder/CancelOrder wiring and no autonomous live BUY loop
from this path.

## 33. Gate 9.2 — NDAX authoritative order / execution / fee verification (2026-09-03)

**Context.** Gate 9.1 hardened the manual accounting path, but before building a
CLI we verified what the current NDAX API actually provides. This is a
**verification/investigation gate**: no CLI, no SendOrder/CancelOrder, no
order placement, no autonomous loop, no `.env` change. Read-only authenticated
calls were permitted because the project already supports them safely
(`ENABLE_AUTHENTICATED_READS=true` + the sanctioned `npm run verify:ndax`
harness), and the signed read path was **live-verified** (33 executions observed).

**Code changes (minimal, evidence-exposing).**
- Added `ExchangeAdapter.getAccountTrades(symbol?)` (READ-ONLY) + NDAX
  implementation (`GetAccountTrades`) + a fail-closed `mapAccountTrade`
  (`src/exchanges/ndax/tradeMappings.ts`) + `AccountTrade` type. This surfaces
  `executionId`, `tradeId`, `orderId`, `clientOrderId`, `accountId`,
  `subAccountId`, `instrumentId`, `feeProductId`, `remainingQuantity`, `value`,
  `orderOriginator`, and the resolved `symbol` — VERBATIM, never coerced, never
  fabricated.
- Reclassified `bindOrderToIntent` as **consistency validation, NOT provenance
  proof** (`OrderBinding.provenanceProof` is always `false`), and documented the
  distinction in code and docs.

**Verified observations (live, read-only).** GetAccountTrades returned 33
executions: `executionId`, `tradeId`, `feeProductId`, `orderId`, resolvable
`symbol`, and `tradeTime` were populated on 100% of rows; `executionId` was
**stable across consecutive reads**; each row mapped to a **distinct orderId**
(executions-per-order max = 1) — so **"one order → many executions" was NOT
observed**, and remains unconfirmed. `GetAccountTrades` is paginated (Count=200)
and **not filterable by `orderId`**, so it is not a reliable indexed way to
enumerate a specific order's executions.

**Conclusions.**
1. **`executionId` is suitable as the idempotent `Fill.executionId` dedup key for
   the LIVE path** (populated, stable, distinct), BUT it is **NOT proven** to be
   universally unique across all executions/time/orders (only a small sample, no
   multi-execution-order counter-example). We therefore **do NOT claim
   exactly-once per-fill accounting**, do NOT claim exchange-side idempotency,
   and do NOT fabricate execution ids. `tradeId` is redundant with `executionId`
   in the sample.
2. **`feeProductId` → fee currency is NOT derivable in code yet.** It is populated
   on every execution, but resolving base vs quote requires `GetProducts`
   (productId → product symbol) plus the instrument's `product1`/`product2`
   ids/symbols from `GetInstruments`, which the adapter's `MarketInfo` does not
   surface. The `mapOrder` `feeCurrency:'quote'` hardcode remains an UNVERIFIED
   assumption and must be removed before execution-level fee accounting is
   trusted. Manual settlement keeps its fail-closed rule (exchange-confirmed
   quote fee only).
3. **OrderId → RETRAC intent provenance is NOT provable.** No authoritative NDAX
   field carries a RETRAC-specific value; `ClientOrderId` may be non-unique; the
   provenance fields are not surfaced. `bindOrderToIntent` is **consistency
   validation only**; attribution relies on the operator's explicit
   acknowledgement.
4. **Model A (current order-level manual settlement) remains the safe core**;
   **Model C (hybrid)** is the recommended future evolution: keep the order-level
   bridge, adopt execution-level records (via `getAccountTrades`) ONLY when an
   `executionId` is present, stable, and bound to the order, and otherwise fall
   back to an explicit non-accounting/reconciliation state. **Model B
   (executionId-level accounting) is NOT recommended now** because uniqueness is
   unproven, per-order lookup is unreliable, and fee currency is unresolved.
   `supportsOrderPlacement` remains `false`.

## 34. Gate 9.3 — final NDAX trade enumeration + fee semantics decision (2026-09-03)

**What was verified (live, read-only).** With `ENABLE_AUTHENTICATED_READS=true`:
- `GetProducts` returns 89 products; `GetInstruments` exposes the instrument's
  explicit `product1`/`product2` ids and `product1Symbol`/`product2Symbol`. The
  adapter now surfaces these on `MarketInfo` (`baseProductId`/`quoteProductId`/
  `baseProductSymbol`/`quoteProductSymbol`) and exposes `getProducts()`.
- Fee-currency resolution on **33 real executions** yielded **base=19, quote=14,
  other=0, unknown=0**, and every `feeProductId` resolved to a named asset.
- **The NDAX `feeCurrency='quote'` assumption is FALSE and unsafe** — real NDAX
  charges fees in the base AND the quote asset (~58% base on this account). It is
  now REMOVED: `mapOrder` (order level + fills) exposes `feeCurrency:'unknown'`
  plus the raw `feeProductId`; authoritative currency is resolved via
  `resolveFeeCurrency(feeProductId, symbol)` using product/instrument metadata.
- GetAccountTrades is paged (StartIndex/Count, max 200), has NO `orderId`/time
  filter, and ordering/retention are undocumented → per-OrderId execution
  enumeration is best-effort, NOT correctness-guaranteed. The live sample saw
  max executions-per-order = 1 (no multi-execution order observed).

**Decisions.**
1. **Fee currency is now authoritatively resolvable** (feeProductId → base/quote/
   other), but the MANUAL bridge does NOT auto-account a fee unless its currency
   is authoritatively quote. `Order.feeCurrency` for NDAX is `'unknown'` by
   default, so `resolveAuthoritativeFee` fails closed — a quote fee from
   GetOrderStatus is not trustworthy, and a base/third-asset fee is never
   converted. `applyLiveFill` likewise refuses any non-zero fee in a non-quote
   currency.
2. **`executionId` is NOT safe for authoritative exactly-once accounting.** It is
   populated/stable/distinct (live) but universal uniqueness is unproven (33-row
   sample, no multi-execution-order counter-example) and per-order enumeration is
   unreliable. `executionIdentityTrustworthy` stays UNKNOWN → the live-BUY
   readiness gate still blocks.
3. **`feeCurrency` type** now includes `'unknown'` (`FeeCurrency`). NDAX surfaces
   raw `fee` + `feeProductId` instead of pretending to know the currency;
   Paper/Backtest/FeeInfo treat 'quote' only as a SIMULATION MODEL, never as
   exchange-authoritative.
4. **Recommended model: A (order-level manual settlement) as the safe ceiling,
   with an explicit Model-C-style reconciliation cap.** Execution-level accounting
   (Model B) is NOT justified: per-order execution enumeration is not
   correctness-guaranteed and executionId uniqueness is unproven. The manual
   order-level path is safe for identity/provenance, but it CANNOT authoritatively
   account an NDAX fee at the order level (currency unknown) — so any fee-bearing
   manual trade must be reconciled by the operator or left in a non-accounting
   state. **A CLI is therefore NOT safe yet.**
5. `supportsOrderPlacement` remains `false`; no SendOrder/CancelOrder; no live
   BUY loop; no `.env` change.

## 35. Gate 9.4 — manual-execution bridge architecture freeze + safe CLI design boundary (2026-09-03)

**Context.** Gate 9.3 established that NDAX charges fees in BOTH base and quote
(not just quote), that `GetAccountTrades` exposes `executionId`/`feeProductId`,
and that the man-ual order-level path can never authoritatively account an NDAX
fee because the order-level fee currency is `'unknown'`. This entry FREEZES the
architecture of the manual (operator-executed) bridge and defines exactly what a
future operator-facing CLI may and may not claim. It is an architecture/security
decision gate: **no CLI was built, no SendOrder/CancelOrder was added,
`supportsOrderPlacement` stays `false`, and no autonomous trading loop exists.**

The governing posture throughout: **an operator-attested, exchange-consistent
manual record is NEVER exchange-proven provenance and NEVER exactly-once live
execution.** RETRAC must be able to say precisely which of those three it is
claiming at the moment it says anything at all.

### 35.1 The four identities are never conflated

| Identity | Example | RETRAC knows | RETRAC can verify | RETRAC cannot verify | Operator provides | RETRAC must never claim |
| --- | --- | --- | --- | --- | --- | --- |
| **Intent identity** | `intentId = manual-<uuid>` (local) | exactly (durable, collision-resistant) | uniqueness/durability locally | that a specific exchange order maps to it | — | that an intent corresponds to a specific exchange order absent operator attestation |
| **Exchange order identity** | NDAX `OrderId` | only as recorded evidence | the order exists on the exchange (`getOrderStatus`) and is *consistent* with the intent (symbol/side/requested-qty/created-time/limit-price) | that it is THE order the operator intended for this intent (provenance) | the `<OrderId>` + explicit acknowledgement | that `OrderId` is proof of intent provenance; that `OrderId` is an execution id |
| **Execution identity** | NDAX `executionId` / `tradeId` | observed: populated, stable, distinct in the live sample | per-row presence/stability; use for display, evidence correlation, best-effort dedupe | universal uniqueness; complete per-order enumeration; financial exactly-once identity | n/a | that `executionId` is globally unique or that `OrderId` → one execution |
| **Provenance proof** | none exists | none exists | nothing | whatever NDAX might have had | (implicit) | that RETRAC ever proved an order belongs to a RETRAC intent |

> **Order identity ≠ intent identity ≠ execution identity ≠ provenance proof.**
> The manual accounting key is the LOCAL `intentId`; the exchange `OrderId` is
> evidence; there is NO execution identity (order-level accounting deliberately
> does not need one); and provenance is operator-attestation + consistency, never
> proof. `OrderId` is a container of zero-or-more executions, never an execution.

### 35.2 Fee-accounting boundary (strict rule)

The four fee qualities are separate and only one of them is useable for
accounting:

1. **Authoritative fee amount** — from an exchange read (`Order.fee`,
   `AccountTrade.fee`).
2. **Authoritative fee currency** — resolved from `feeProductId` → product →
   instrument base/quote (`resolveFeeProduct`). At the ORDER level (`getOrderStatus`)
   NDAX exposes `feeCurrency: 'unknown'`; the currency is ONLY resolvable at the
   EXECUTION level (`getAccountTrades` + `getProducts`/`getInstruments`).
3. **Operator-entered fee** — a HINT, never authoritative.
4. **Modelled fee** — a risk/paper simulation parameter (flat 0.20%), never
   exchange-authoritative.

**Strict rule (fail closed):** the order-level bridge can account a fee ONLY when
ALL of the following hold: the amount is authoritative, the currency is
authoritatively resolved to `'quote'`, and the evidence the fee derives from is
PROVEN COMPLETE. For a real NDAX order none of that is simultaneously true
(order-level currency is `'unknown'`; execution-level currency is resolvable but
per-order execution enumeration is not correctness-guaranteed). **Therefore the
current order-level bridge can NEVER safely auto-account an NDAX fee.** Auto
accounting must STOP and the intent must enter a non-accounting,
`RECONCILIATION_REQUIRED` state (see §35.5). The invariant is encoded today in
`ManualTradeBridge.resolveAuthoritativeFee` (`''unknown''` → fail closed) — the
path already refuses to settle rather than silently assume quote.

Concrete outcomes:
- fee currency `'quote'` + authoritative + complete → account the fee (the only
  accounting case, currently only reachable with a non-NDAX/explicitly-resolved
  quote fee, e.g. the `FakeExchange` fixture, **not** a real NDAX order).
- fee currency `'base'` → fail closed (never convert a base fee to quote).
- fee currency `'unknown'` → fail closed (the real NDAX order-status shape).
- fee missing / zero → fail closed from `resolveAuthoritativeFee`.
- execution records incomplete, or multiple executions with different fees →
  cannot prove the order-level fee → fail closed.

### 35.3 Execution-accounting boundary (`executionId` usage)

| Intended use | Allowed? | Rationale |
| --- | --- | --- |
| Display only | **YES** | observed populated/stable in live data (33 execs) |
| Evidence correlation | **YES** | stable across repeated reads; useful to match a trade record to an order |
| Best-effort deduplication | **YES** | distinct within the observed window; fine to avoid re-showing the same row |
| Authoritative accounting | **NO** | universal uniqueness NOT proven (small sample; no multi-execution counter-example) |
| Exactly-once accounting | **NO** | per-order enumeration is NOT correctness-guaranteed (paged, no `orderId`/time filter, undocumented ordering/retention) |

`executionId`/`tradeId` remain available as an *audit* reference on the order
level path; they are NEVER the accounting key. Order-level manual accounting is
keyed by the local `intentId` and never depends on `executionId`.

### 35.4 Operator attestation as a security boundary

**Decision: YES — operator attestation IS a valid security boundary for the
manual, operator-in-the-loop model**, provided it is recorded as attestation and
NEVER upgraded to provenance proof or exchange-proof.

Exact guarantee RETRAC may claim: *"A human operator explicitly acknowledged that
they executed this RETRAC intent using exchange OrderId X; RETRAC validated the
order against an authoritative exchange read (symbol/side/quantity/time/limit),
recorded the assertion as coming from the operator, and accounted the order
aggregate at the operator's direction. Provenance was NOT cryptographically or
exchange-proven; accounting is based on operator attestation plus exchange
evidence."*

Why this is a valid boundary:
- The operator is the actor with authority and access to funds on the exchange;
  RETRAC is only recording and validating their act, not automating it.
- The assertion is recorded with its SOURCE (`evidenceSource`, operator identity,
  confirmation flags), so it is auditable and distinct from an exchange-derived
  fact.
- Every risky decision is gated on an explicit operator acknowledgement
  (`confirm`, `confirmSettle`, `confirmCancel`), so RETRAC never assumes consent.

Why it is NOT a provenance proof: NDAX exposes no field that carries a
RETRAC-specific value; `ClientOrderId` may be non-unique; and no NDAX field
proves an order belongs to a RETRAC intent. `bindOrderToIntent` is consistency
validation only (`provenanceProof` is always `false`).

### 35.5 State semantics — SETTLED is too strong; rename before the CLI

The current order-level state machine is
`PROPOSED → CONFIRMED → EVIDENCE_RECORDED → SETTLED` (plus `CANCELED`/`VOID`/
`AMBIGUOUS`). **`SETTLED` is misleading as a name** because:
1. It claims finality of financial effect, but a real NDAX order can never be
   settled with an authoritative fee at the order level → it never reaches
   `SETTLED` (it fails closed instead), so the label is effectively unreachable
   for the dominant NDAX case.
2. Where it IS reachable (an authoritative quote fee via a non-NDAX/explicitly-
   resolved source), it still does NOT mean "exchange-proven provenance" — it
   means "operator-attested + exchange-consistent accounting."

**Precise current meaning of `SETTLED`:** *"RETRAC has applied an
operator-attested external execution to this intent after exchange consistency
validation and explicit settlement confirmation, at the order aggregate level,
with an exchange-authoritative quote fee."*

**Recommended replacement before any CLI is built and shown to a user:**
- Replace `SETTLED` with **`ACCOUNTED_WITH_EXCHANGE_VALIDATION`** (an order whose
  authoritative quote fee was used) or **`ACCOUNTED_WITH_OPERATOR_ATTESTATION`**
  (accounted where the fee/evidence relied on the operator's attestation). Both
  explicitly say the accounting is NOT exchange-proven provenance.
- Add a distinct **`RECONCILIATION_REQUIRED`** state for the dominant NDAX case:
  the exchange evidence is consistent and the order is terminal, BUT the fee (or
  the full execution set) cannot be proven, so NO accounting is applied and the
  order must be reconciled by the operator before it can be treated as settled.
- Keep **`AMBIGUOUS`** for the genuinely *contradictory* case (operator evidence
  disagrees with the exchange, or a binding factor fails) — which is different
  from "proven consistent but fee-unaccountable."

This distinction (proven-consistent-but-fee-unaccountable vs contradictory) is
the single most important thing the CLI must be able to state truthfully. The
current code funnels both into `AMBIGUOUS`; that is safe (fail closed, no
accounting, reservation retained) but is semantically misleading to an operator,
and is therefore flagged as the one prerequisite before a truthful CLI. **This
gate does NOT change the state machine** (it stays `AMBIGUOUS` today); the split
is recorded as the required Gate 9.5 step.

### 35.6 Reconciliation state machine (design, fail-closed)

> **Implementational note:** the table below is the Gate 9.4 design intent. The
> statuses `SETTLED`/`ACCOUNTED` were concretely split in **§36 (Gate 9.5)** into
> `ACCOUNTED_WITH_EXCHANGE_VALIDATION`, `ACCOUNTED_WITH_OPERATOR_ATTESTATION`, and
> a distinct `RECONCILIATION_REQUIRED`; §36 is authoritative for the implemented
> states and their transitions.

For each scenario, the *intended* outcome under the frozen architecture:

| Scenario | State | Accounting? | Reservation released? | safeToTrade=false? | Operator action required? |
| --- | --- | --- | --- | --- | --- |
| OrderId missing | RECONCILIATION_REQUIRED | NO | NO (exec may exist) | YES | supply OrderId / reconcile |
| OrderId malformed (non-numeric) | RECONCILIATION_REQUIRED | NO | NO | YES | supply valid OrderId |
| OrderId valid but unrelated (no binding) | RECONCILIATION_REQUIRED | NO | NO | YES | reconcile (true order ≠ intent) |
| OrderId consistent but provenance-unproven | can proceed ONLY with operator attestation | YES-if-fee else NO | release after settle | (depends) | attest |
| Order still open (non-terminal) | PENDING | NO | NO (may fill) | no | wait / complete externally |
| Order partially filled | PENDING (settle uses final terminal aggregate) | NO | NO | no | wait for terminal |
| Order terminal, zero fill | CANCELED | NO | YES (exactly once) | no | none (auto) |
| Order terminal, positive fill | SETTLED if fee provable quote+complete; else RECONCILIATION_REQUIRED | YES-if-fee | release after settle | (depends) | possibly none |
| Trade records incomplete | RECONCILIATION_REQUIRED | NO | NO | YES | reconcile |
| Fee currency unknown | RECONCILIATION_REQUIRED | NO | NO | YES | reconcile |
| Multiple executions, differing fee records | RECONCILIATION_REQUIRED (if deriving order fee) | NO | NO | YES | reconcile |
| Execution enumeration incomplete | RECONCILIATION_REQUIRED | NO | NO | YES | reconcile |
| Exchange read fails | RECONCILIATION_REQUIRED | NO | NO | YES | retry / reconcile |
| Exchange read disagrees with operator evidence | AMBIGUOUS (contradictory) | NO | NO | YES | reconcile |
| Crash after portfolio settlement, before intent finalize | reconcile finalizes intent to SETTLED/ACCOUNTED (no re-account) | already applied | already released | no | none (auto repair) |
| Crash before intent finalization (settlement recorded) | reconcile finalizes | already applied | already released | no | none (auto repair) |
| Intent store corrupt | CORRUPT (throws) | NO | NO | YES | operator |
| Reservation exists without intent (orphan) | error reporting | NO | NO | YES | operator |
| Intent (BUY, non-terminal) without reservation | error reporting | NO | NO | YES | operator |
| Positive external execution may exist, not safely attributable | RECONCILIATION_REQUIRED | NO | NO | YES | operator |

**Hard rule:** an AMBIGUOUS or RECONCILIATION_REQUIRED state can NEVER silently
become a successful/settled path. A reservation is NEVER auto-released where a
positive external execution may exist; `reconcile()` never fabricates a fill and
never auto-releases on uncertainty.

### 35.7 Reservation guarantees (safe to expose to an operator)

Confirmed safe: reservation created BEFORE operator execution (`propose`), tied
1:1 to the intent by `intentId`, no missing-reservation settlement (throws),
no under-reservation settlement (cost ≤ reserved, throws), partial fill consumes
only the actual aggregate cost, leftover released EXACTLY once, zero-fill terminal
order releases the reservation, unresolved positive external execution does NOT
automatically release, and `reconcile()` handles orphan/missing-reservation cases
safely (reports, never auto-releases). Reservation status (amount/remaining/
currency) is safe to expose read-only.

### 35.8 CLI capability classification (frozen)

| # | Operation | Classification | Why / constraints |
| --- | --- | --- | --- |
| 1 | Create/propose manual intent | **SAFE** | runs the normal RiskManager; creates PROPOSED + reserves quote (BUY); no order placement |
| 2 | Confirm intent | **SAFE** | PROPOSED→CONFIRMED; explicit operator acknowledgement |
| 3 | Display operator instructions | **SAFE** | read-only display of the proposal; never fabricates |
| 4 | Record an externally supplied OrderId | **SAFE WITH EXPLICIT LIMITATION** | recorded as operator-attested EVIDENCE; never provenance/execution-proof; must be labelled non-proven |
| 5 | Read authoritative NDAX order status | **SAFE** | read-only `getOrderStatus`; no mutation |
| 6 | Retrieve account trade evidence | **SAFE WITH EXPLICIT LIMITATION** | read-only, but enumeration is best-effort; must be labelled non-complete, never "all executions" |
| 7 | Resolve fee currency | **SAFE** | `resolveFeeProduct` (feeProductId→product→base/quote); other/unknown fail closed |
| 8 | Attempt automatic accounting | **SAFE WITH EXPLICIT LIMITATION** | ONLY if it declines on any unprovable fee/currency/completeness; never records a fee it could not verify; must route to RECONCILIATION_REQUIRED rather than SETTLED |
| 9 | Enter reconciliation state | **SAFE WITH EXPLICIT LIMITATION** | transition to a reconciliation marker ONLY when it genuinely cannot account; must not be reachable without a real, unresolvable condition |
| 10 | Cancel a RETRAC manual intent | **SAFE WITH EXPLICIT LIMITATION** | requires confirmCancel, no positive-fill evidence, and not terminal/ambiguous; never releases on an ambiguous order |
| 11 | Display reservation status | **SAFE** | read-only view of per-intent reservation + deployable quote |
| 12 | Run recovery/reconcile | **SAFE WITH EXPLICIT LIMITATION** | `ManualTradeBridge.reconcile` does deterministic repairs only, never fabricates a fill, never auto-releases on possible positive execution; reports and can set safeToTrade=false |

**Sole unconditional classification: NO operation places/cancels a real order and
NO operation claims exchange-proven provenance or exactly-once live execution.**

### 35.9 Gate 9.4 conclusions

- The manual bridge is architecturally coherent as a **non-autonomous,
  operator-in-the-loop, order-level** workflow. It is NOT autonomous trading.
- It CANNOT authoritatively account an NDAX fee at the order level (order-level
  fee currency is `'unknown'`); it fails closed rather than guess.
- `executionId` is display/evidence/dedupe only — never authoritative or
  exactly-once accounting.
- OrderId → RETRAC-intent provenance is NOT exchange-proven; it is operator
  attestation + consistency validation.
- Operator attestation is a valid boundary for this manual model, recorded as
  attestation, never as provenance proof.
- `SETTLED` is too strong a name; the architecture requires renaming to
  `ACCOUNTED_WITH_EXCHANGE_VALIDATION`/`ACCOUNTED_WITH_OPERATOR_ATTESTATION` and
  adding `RECONCILIATION_REQUIRED` (distinct from `AMBIGUOUS`) before a truthful
  CLI. **This gate defers that state-machine change to Gate 9.5.**
- `supportsOrderPlacement` remains `false`; no SendOrder/CancelOrder; no live BUY
  loop; no `.env` change; no CLI was built.

## 36. Gate 9.5 — manual-execution bridge state-semantics split (2026-09-03)

**Context.** Gate 9.4 froze the architecture and flagged one prerequisite before
a truthful manual CLI: the old `SETTLED` state conflated several distinct
meanings. This gate IMPLEMENTS that split. It is state-semantics only: **no CLI
was built, no SendOrder/CancelOrder was added, `supportsOrderPlacement` stays
`false`, and no autonomous trading loop exists.**

### 36.1 Why `SETTLED` was removed

The old `SETTLED` implied a single, unqualified form of successful settlement but
actually meant three different things at once:
1. **Accounting authority** — who dictated the numbers (exchange vs operator).
2. **Exchange evidence** — the order was consistency-validated against the intent.
3. **Provenance proof** — NDAX provides none; attribution is operator-attested.

That conflation was unsafe/ambiguous because an operator could reasonably read
`SETTLED` as "exchange-proven provenance" or "exactly-once execution", neither of
which is true. It also made "fee cannot be authoritatively accounted" (the
dominant NDAX case) collapse into a single `AMBIGUOUS` that was indistinguishable
from truly contradictory evidence.

### 36.2 The new state model

`PROPOSED` · `CONFIRMED` · `EVIDENCE_RECORDED` · `PENDING` · `CANCELED` · `VOID` ·
`AMBIGUOUS` · `RECONCILIATION_REQUIRED` ·
`ACCOUNTED_WITH_EXCHANGE_VALIDATION` · `ACCOUNTED_WITH_OPERATOR_ATTESTATION`.

Exact meanings (implemented in `src/manual/types.ts`):
- **`ACCOUNTED_WITH_EXCHANGE_VALIDATION`** — "RETRAC completed accounting using
  authoritative exchange evidence sufficient for the accounting performed,
  including an authoritative quote fee where a fee exists. The external order was
  consistency-validated. This does NOT imply exchange-proven provenance." Used
  when `settle()` is called with `accountingAuthority: 'exchange'` (default).
- **`ACCOUNTED_WITH_OPERATOR_ATTESTATION`** — "RETRAC completed accounting after an
  explicit human operator attestation identifying the external OrderId, with
  authoritative exchange consistency validation. Accounting depends on operator
  attestation for intent-to-order attribution. Exchange provenance is NOT proven."
  Used with `accountingAuthority: 'operator_attestation'`. Identical hard gates;
  the mode only records the accounting authority explicitly.
- **`RECONCILIATION_REQUIRED`** — "RETRAC has evidence that may represent an
  external execution or otherwise cannot safely determine the final accounting
  state. Automatic authoritative accounting is refused; the reservation/managed
  inventory stays conservative until a safe deterministic resolution." Used for
  fee-currency unknown/base/other, missing/unreadable exchange evidence, or an
  inability to complete accounting. It is DISTINCT from `AMBIGUOUS`.
- **`AMBIGUOUS`** — "Evidence conflicts or multiple interpretations are possible
  such that RETRAC cannot safely determine the state." Reserved for genuine
  contradiction (operator vs exchange mismatch, binding/over-fill failure,
  accounting invariant violation). It is NOT a generic synonym for "fee
  unavailable."
- **`PENDING`** — the external order is not yet terminal (open/partial, may still
  fill); reservation retained, no accounting.

### 36.3 Accounting vs provenance separation (explicit metadata)

The distinction is kept explicit rather than inferred from a string:
- `ManualSettlement.settlementMode: 'exchange_validated' | 'operator_attested'` —
  the ACCOUNTING AUTHORITY that dictated the recorded numbers (mirrors the intent
  state).
- `ManualSettlement.provenanceProof: false` — always the literal `false`. Because
  it is a literal type, it is impossible to ever be `true`.
- `ManualSettlement.exchangedValidated: boolean` — exchange consistency was
  validated (kept as before; does NOT imply provenance).
- `evidenceSource` / `operatorConfirmedBy` — where the operator's attestation came
  from and who gave it.

Thus the model preserves four independent facts: **accounting authority**,
**exchange evidence**, **operator attribution**, and **provenance proof**. Neither
ACCOUNTED state implies exchange-proven provenance; both imply exchange consistency
was validated and attribution was operator-attested.

### 36.4 Legal transitions (enforced)

- `PROPOSED → CONFIRMED` (only; confirm is one-way).
- `CONFIRMED → EVIDENCE_RECORDED` (record evidence). Also `CONFIRMED → CANCELED`
  (no fill, explicit confirmCancel, no positive-fill evidence).
- `EVIDENCE_RECORDED → PENDING` (order still open) · `→ ACCOUNTED_*` (accounted)
  · `→ RECONCILIATION_REQUIRED` (fee/evidence unaccountable) · `→ CANCELED`
  (terminal no-fill) · `→ AMBIGUOUS` (contradiction).
- `PENDING → PENDING` (still non-terminal) · `→ ACCOUNTED_*` (later terminal) ·
  `→ RECONCILIATION_REQUIRED` · `→ CANCELED` (terminal no-fill, via settle) ·
  `→ AMBIGUOUS`.
- `RECONCILIATION_REQUIRED → ACCOUNTED_*` (once evidence/fee is safe) · `→
  AMBIGUOUS` (if a contradiction is later found). It is NOT auto-transitioned to
  success merely because later evidence is available — it must pass the same
  evidence/attestation gates.
- `AMBIGUOUS` stays `AMBIGUOUS` unless a new authoritative/explicitly-attested
  evidence path (`recordEvidence`) resolves it.
- `ACCOUNTED_*` are terminal AND idempotent: no second accounting; a conflicting
  repeat fails closed (`Portfolio.settleManualOrder` throws on a different payload).

Deviations from the gate's illustrative graph, both preserving a stronger safety
invariant:
- `CANCELED` is only reachable from `PROPOSED`/`CONFIRMED`/`EVIDENCE_RECORDED`
  (with no positive-fill evidence). `PENDING`/`AMBIGUOUS`/`RECONCILIATION_REQUIRED`
  are NOT directly cancelable: an external order may still fill, so a reservation
  is never silently released on uncertainty. The safe `CANCELED` path for a
  terminal-zero-fill order is via `settle` (which releases exactly once).

### 36.5 Fee semantics (unchanged, fail-closed)

Automatic authoritative accounting does NOT occur if the fee currency is unknown
when a non-zero fee exists, the fee is base/other, trade enumeration needed for the
claim is incomplete/unproven, exchange evidence disagrees, the exchange read fails,
or the fee is operator/modelled. A base/other/unknown fee routes to
`RECONCILIATION_REQUIRED`. Operator/modelled fee values are recorded as hints only
and never become authoritative inputs. A base fee is NEVER reinterpreted as quote.

### 36.6 Reservation semantics (unchanged)

All Gate 9.1–9.4 guarantees hold: reservation before external execution, tied 1:1
by `intentId`, active-reservation required to settle, under-reserve fails before
mutation, actual aggregate cost consumed, leftover released exactly once,
duplicate accounting cannot double-release, unresolved positive execution does NOT
release the reservation. `RECONCILIATION_REQUIRED` and `AMBIGUOUS` both retain the
reservation; a deterministic safe terminal zero-fill releases it exactly once.
SELL ownership rules are unchanged (managed inventory only; never unauthorized
external inventory).

### 36.7 Reconciliation semantics (updated)

`ManualTradeBridge.reconcile` now finalizes the intent status to the ACCOUNTED
state matching the recorded settlement's `settlementMode` (no re-accounting),
reports `RECONCILIATION_REQUIRED` and `AMBIGUOUS` as blocking (`safeToTrade=false`),
keeps their reservations retained, releases a leaked reservation on a terminal
zero-fill intent exactly once, treats `PENDING` as in-progress (reservation
retained), and never fabricates a fill or auto-releases on uncertainty. A corrupt
store fails closed.

### 36.8 Persistence / migration

The manual-intent store is bumped to `version: 2`. A `version: 1` store is migrated
**status-only** on load: the old `SETTLED` → `ACCOUNTED_WITH_EXCHANGE_VALIDATION`
(the old settle path always used an authoritative quote fee and exchange
consistency validation; `provenanceProof` was never `true`). All other fields are
carried through verbatim. A `version: 2` store that still contains `SETTLED` is
REJECTED as corrupt (fail closed). The portfolio's `ManualSettlement` gained
`settlementMode` + `provenanceProof`; legacy rows default them on read
(`exchange_validated` when `exchangedValidated`, else `operator_attested`) and
`provenanceProof` HARD-CODES to `false`. No CLI, no order placement.

### 36.9 Test coverage added (adversarial)

`tests/unit/manual/manualStateSplit.test.ts` covers: exchange-validated vs
operator-attested accounting (state + `settlementMode` + `provenanceProof=false`),
exchange validation ≠ provenance proof, unknown/base fee → `RECONCILIATION_REQUIRED`
(no accounting, reservation retained), ambiguous contradiction → `AMBIGUOUS`
(reservation retained), terminal zero-fill → reservation released exactly once,
idempotent + conflicting-repeat-rejected accounting, restart preserving the new
terminal states and settlement mode, v1→v2 migration and v2-`SETTLED`-rejected,
the full lifecycle never calling `placeOrder`/`cancelOrder`, and
`supportsOrderPlacement === false`. Existing suites were updated to the new states.

### 36.10 What this gate does NOT claim

- It does NOT prove NDAX execution completeness.
- It does NOT prove universal `executionId` uniqueness.
- It does NOT make the manual workflow autonomous.
- `supportsOrderPlacement` remains `false`; no SendOrder/CancelOrder; no live BUY
  loop; no `.env` change; no CLI was built.

## 37. Gate 9.6 — the constrained manual-execution CLI (2026-09-03)

**Context.** Gate 9.5 finalized the explicit state semantics. This gate adds the
operator-facing CLI around the frozen manual bridge. It is an **operator
interface, not a trading interface**: it places nothing, cancels nothing, and
modifies no exchange order. It reuses the existing `ManualTradeBridge` domain API
and never duplicates risk/reservation/accounting business logic.

### 37.1 Framework / entrypoint

No CLI framework was added. The existing `bot <command>` dispatcher
(`src/cli/cli.ts`) was extended with a single `manual` command backed by
`src/cli/manual-cmd.ts`. It uses the project's existing logger/config/persistence
conventions and no new dependency. The composable core (`runManualCommand`) takes
injected deps (`cfg`, read-only `adapter`, `bridge`, `getPortfolio`,
`riskManager`) so it can be tested against a `FakeExchange` without network or a
TTY.

### 37.2 Structural read-only guarantee

The CLI never receives a write-capable adapter. `toReadOnlyAdapter` wraps the
adapter in a `Proxy` whose `placeOrder`/`cancelOrder` return a function that
throws; every read (`getTicker`, `getOrderBook`, `getMarketInfo`, `getBalances`,
`getOrderStatus`, `getAccountTrades`, `getMarkets`, optional
`resolveFeeCurrency`) delegates to the underlying adapter. There is no code path
from any `manual` sub-command to an exchange write. `supportsOrderPlacement`
remains `false`.

### 37.3 Commands

| Command | Purpose |
| --- | --- |
| `manual propose [--symbol SYM] [--side BUY\|SELL] [--reason t] [--limit-price X] [--sell-target-cad N]` | re-run the normal risk pipeline, create a durable PROPOSED intent (+ BUY reservation / SELL managed-inventory check), display it, and state that RETRAC placed no order |
| `manual show <intentId>` | structured summary (identity / trade / accounting / safety) |
| `manual confirm <intentId> [--operator]` | operator approves the intent for external execution (not execution/evidence) |
| `manual instructions <intentId>` | external-execution steps; explicitly says RETRAC will NOT place, to preserve the OrderId, that an OrderId is not provenance, and that RETRAC only does read-only consistency checks |
| `manual evidence <intentId> --order-id <X> [...]` | record operator-returned evidence (OrderId + hint fields), via the bridge |
| `manual verify <intentId>` | read-only `getOrderStatus` + `getAccountTrades` + fee resolution; reports EXCHANGE VALIDATION (consistent/not) and PROVENANCE: NOT PROVEN; labels trade evidence "Observed exchange trade evidence", never "complete execution record" |
| `manual settle <intentId> [--accounting-authority exchange\|operator_attestation] [--confirm]` | calls the existing bridge settle; prints the exact ACCOUNTED_* / RECONCILIATION_REQUIRED / AMBIGUOUS / PENDING / CANCELED result and its provenance wordings |
| `manual reconcile [intentId]` | deterministic local recovery; shows state / evidence / reservation / safeToTrade / next action |
| `manual cancel-intent <intentId> [--confirm]` | cancels ONLY the LOCAL manual intent (never an exchange order); respects the fail-closed reservation rules |
| `manual reservations` | read-only reservation view |
| `manual list` | read-only intent list |

Commands intentionally NOT provided: buy, sell, place, send, cancel-order,
modify-order, execute. `cancel-intent` is the only cancel verb and is the local
intent cancel, never an exchange cancel.

### 37.4 Safety wording / semantics

- The tool always states RETRAC has placed no exchange order.
- `provenanceProof` is always `false` in output; the CLI says "Exchange
  consistency validated; intent-to-OrderId provenance remains operator-attested
  and is not exchange-proven."
- `ACCOUNTED_WITH_EXCHANGE_VALIDATION` → "Accounting completed using
  exchange-authoritative evidence. Intent-to-order provenance is STILL NOT
  exchange-proven." `ACCOUNTED_WITH_OPERATOR_ATTESTATION` → "Accounting completed
  using operator attestation plus exchange consistency validation. Exchange
  provenance is NOT proven."
- Fee states are never rounded away and never silently substituted: QUOTE / BASE
  / OTHER / UNKNOWN / MISSING / UNRESOLVED / OPERATOR_HINT. A non-zero non-quote
  fee → "Accounting cannot be completed safely because the fee currency/evidence
  is not authoritative. Intent remains RECONCILIATION_REQUIRED."
- `executionId`/`tradeId` are shown only when observed, as evidence; never
  fabricated, never presented as complete/authoritative for the OrderId.

### 37.5 Output / exit codes

`--json` emits a stable structured object (`intentId`, `state`, `settlementMode`,
`provenanceProof`, `exchangeValidated`, `operatorAttested`, `fee` status,
`reservation`, `safeToTrade`, etc.), never reduced to a bare
`success:false`. Exit codes: `0` = completed safely; `2` = blocked/fail-closed
(RECONCILIATION_REQUIRED, AMBIGUOUS, PENDING, not safe-to-trade, refused);
`1` = error (config, not found, invalid args/transition, exchange read failure,
corrupt store). Errors are concise and never print credentials/secrets.

### 37.6 Tests

`tests/unit/cli/manual-cmd.test.ts` covers: propose creates a durable intent and
places nothing; confirm/instructions/evidence never place; an unrelated OrderId
fails closed in verify; verify is read-only and the proxy rejects writes; unknown
and base fees → RECONCILIATION_REQUIRED (fee never becomes quote); exchange- and
operator-attested accounting produce the correct states with `provenanceProof=false`;
AMBIGUOUS stays blocked with the reservation retained; zero-fill cancels release
once; duplicate settlement is idempotent; restart preserves intent state + mode;
a corrupt store fails closed; `cancel-intent` never invokes an exchange cancel;
and the **global negative test** — running every `manual` sub-command against a
`FakeExchange` never invokes a write method and never submits an order.

### 37.7 No autonomous trading

The CLI cannot place/cancel orders; it is not a trading terminal or an automated
execution engine. `supportsOrderPlacement` remains `false`; no SendOrder /
CancelOrder; no live BUY loop; no `.env` change; nothing committed or pushed.

## 38. Gate 9.7 — cumulative manual bridge security audit (2026-09-03)

**Context.** A cumulative adversarial audit of the manual-execution bridge and its
constrained CLI (Gates 9.1–9.6), with the cross-store (intent + portfolio)
atomicity model, accounting-authority/provenance separation, reservation
conservation, fee fail-closed rules, execution-identity separation, and the
read-only CLI capability boundary called into question. **One demonstrated
safety defect was found and fixed; no new product functionality was added.**

### 38.1 Defect found and fixed: cross-intent duplicate-OrderId accounting

**Defect (demonstrated).** The manual accounting primitive was keyed only by the
local `intentId`. Because one external exchange `OrderId` is the closest thing to
a real order identity RETRAC has, two DIFFERENT intents that both recorded the
SAME external `OrderId` could both settle, accounting the SAME real fill twice
(e.g. a single 0.125 BTC real order inflating the managed position to 0.25 BTC).
This violated "no duplicate accounting" / "no double-account of one real
execution".

**Fix (conservative, at the authoritative accounting boundary).**
`Portfolio.settleManualOrder` now rejects a settlement whose external `orderId`
is already recorded by a DIFFERENT intent's manual settlement, BEFORE any
mutation (no cash/position/reservation touched). It is a hard invariant: one
external `OrderId` is never accounted by more than one intent. Same-intent
idempotency and conflicting-same-intent rejection are unchanged.

**Regression tests:** `tests/unit/manual/manualPortfolio.test.ts` (portfolio-level
guard: the second intent is refused, position NOT doubled, reservation retained)
and `tests/unit/manual/manualBridge.test.ts` (end-to-end: second intent settles
to `AMBIGUOUS`, nothing double-accounted).

### 38.2 Invariants re-verified (no defect found)

- **State machine:** `PROPOSED→CONFIRMED→EVIDENCE_RECORDED→PENDING→…`; no path
  skips confirmation/evidence/consistency/fee/reservation gates; a settlement
  mutates the portfolio only after ALL preconditions pass; accounting is keyed by
  `intentId` (idempotent) and an external `OrderId` is never accounted twice;
  `AMBIGUOUS`/`RECONCILIATION_REQUIRED` cannot become success without a fresh
  gated evidence/attestation+exchange-validation path.
- **Accounting authority vs provenance:** `settleManualOrder` and `settle()` use
  only authoritative exchange quantity/price/fee/currency; operator/modelled fee
  is a hint; `provenanceProof` is a literal `false`; `settlementMode` records
  authority explicitly. Neither ACCOUNTED state implies exchange provenance.
- **Reservation conservation / BUY:** `actual cost ≤ reserved` enforced before
  mutation; leftover released exactly once; `reserved ≤ cash` invariant holds
  across reserve/fill/release, so no negative quote balance is reachable; base /
  unknown / third-asset fees are never converted to quote.
- **SELL/ownership:** a SELL only consumes managed inventory (`positions`, BOT or
  EXTERNAL_AUTHORIZED); unauthorized external snapshot is never consumed;
  `applyFill` refuses a SELL larger than the held managed position.
- **Execution identity:** `executionId`/`tradeId` are surfaced verbatim from
  `GetAccountTrades` (or null), never fabricated/derived from an `OrderId`; the
  manual path never routes through `applyLiveFill` and never writes
  `appliedExecutions`; the live `applyLiveFill` requires a trustworthy
  `executionId` and rejects cross-order/conflicting repetitions.
- **Fee resolution:** `resolveFeeProduct` uses explicit product/instrument IDs
  (never symbol-string parsing), keeps base/quote/other/unknown distinct, and
  fails closed on unknown/missing.
- **Enumeration:** `getAccountTrades` respects pagination (page 200, cap 10000,
  short-page break) and its docstring + the CLI state that the result is an
  observation, never a guaranteed-complete per-OrderId set.
- **Reconciliation:** deterministic repairs only (finalize an already-accounted
  intent, release a leaked reservation on a proven terminal zero-fill); never
  fabricates a fill, never infers a fee currency, never releases a reservation on
  a possible positive execution, and reports `AMBIGUOUS`/`RECONCILIATION_REQUIRED`
  /missing-reservation/orphan/corrupt-store as `safeToTrade=false`.
- **CLI capability boundary:** the adapter handed to `bot manual` is a read-only
  proxy that throws on `placeOrder`/`cancelOrder`; no `manual` sub-command can
  reach an exchange write; the global negative test runs every sub-command and
  asserts zero writes and zero submitted orders.
- **Persistence/migration:** v1→v2 migrates old `SETTLED` conservatively
  (`ACCOUNTED_WITH_EXCHANGE_VALIDATION`); v2-with-`SETTLED` is rejected;
  `provenanceProof` cannot become `true` through deserialization; malformed /
  unexpected-version JSON fails closed.

### 38.3 Known, accepted limitations (not defects, documented)

- At the ORDER level an authoritative NDAX fee is never obtainable (currency is
  `'unknown'`), so a fee-bearing real NDAX order lands in
  `RECONCILIATION_REQUIRED` rather than an ACCOUNTED state — accounting refuses
  rather than guess.
- `executionId` universal uniqueness and per-OrderId enumeration completeness are
  NOT proven; exactly-once execution/accounting is NOT claimed.
- Operator attestation is the attribution layer; if an operator attests falsely
  (e.g. records an OrderId that is not the one it executed, or cancels an intent
  it actually executed), RETRAC cannot detect that — this is inherent to a
  non-autonomous, operator-in-the-loop model and is recorded as attestation, not
  proof.

### 38.4 Validation

`npm test` → 62 files, **797 passed** (two new regression tests). `npm run
typecheck`, `npm run lint`, `npm run build` all clean. `supportsOrderPlacement`
remains `false`; no SendOrder/CancelOrder; no autonomous trading; no `.env`
change; nothing committed or pushed.

## 39. Backtesting V1 — deterministic historical simulator (2026-09-04)

**Context.** The backtesting architecture gate was approved, then clarified
(factory-based fresh state, explicit market constraints, decision-time risk vs
execution-time safety). This entry records the implementation decisions. It is a
strictly historical/simulation subsystem: no live order placement, no
SendOrder/CancelOrder, no autonomous trading, `supportsOrderPlacement` stays
`false`, and the live/paper/manual safety boundary is unchanged.

### 39.1 Public boundary

`runBacktest({ candles, config, createStrategy, createRiskManager })` is the
engine. It accepts FACTORIES, not pre-instantiated mutable `Strategy` /
`RiskManager` objects. The engine calls each factory EXACTLY ONCE per run, uses
the returned instances for that run only, and discards them — so no state
(`MovingAverageCrossoverStrategy.crossState`, `RiskManager.cooldownUntilMs` /
`killSwitchActive`) can leak between runs. No `reset()` API, no cloning, no
serialization, no DI framework: freshness comes from construction inside each
run.

### 39.2 Timestamp semantics

`Candle.timestampMs` is the candle **END/CLOSE** time (matches the NDAX
`GetTickerHistory` `DateTime[0]`, CCXT convention). The type comment was
corrected to say so; no live/paper behavior changed.

### 39.3 Event ordering (C1, no lookahead)

- Decision for bar `i` uses completed candles `[0..i]` only, evaluated at
  `close[i]` (`timestampMs`).
- Strategy signal → `RiskManager.evaluate` **exactly once** at `close[i]`.
- An approved order becomes an IMMUTABLE pending intent `{ side, quantity }`
  (never re-sized, never re-approved).
- The pending intent fills COMPLETELY at the next available bar's OPEN
  (`open[i+1]`); a gap uses the next present bar's open and never synthesizes a
  price.
- Fill time performs execution-safety checks ONLY (valid price, tick
  normalization, min quantity, A1 affordability at the actual fill price, SELL
  position sufficiency, fee/slippage validity). If they fail, the order is
  REJECTED cleanly (portfolio unchanged) — not resized or partially filled.
- Equity is marked at `close[i]`.
- No partial fills in V1.

### 39.4 Fill / fee / precision

- BUY fill price = `open × (1 + slippage)`, rounded **UP** to `priceTick`;
  SELL = `open × (1 − slippage)`, rounded **DOWN**.
- Fee is a QUOTE-denominated percentage of notional, exact fixed-point
  (`Money.mulFraction`). A base-denominated fee config is REJECTED (fail closed),
  never silently converted.
- Exact `Money` (BigInt) throughout; no floating-point monetary accounting.
- Negative fee/slippage and non-finite values are rejected.

### 39.5 Market constraints (no invented defaults)

The engine requires explicit `BacktestMarketConstraints { priceTick,
quantityTick, minOrderBase }`. `priceTick` and `quantityTick` must be strictly
positive and are NEVER defaulted (there is no mathematically neutral value — a
default is an arbitrary exchange-specific assumption). `minOrderBase: null` is
the ONLY neutral nullable field (means "no minimum enforced"). Missing/invalid
constraints are rejected. The result records the exact constraints and marks
them `explicit`, so a user always knows whether real market metadata was used.

### 39.6 Output / metrics

`BacktestResult` includes a config snapshot, symbol/timeframe, data start/end,
market constraints, fee/slippage assumptions, trades (deterministic ids
`bt-<symbol>-<barIndex>-<seq>-<side>`), rejections (decision + execution
phases), equity curve, and metrics (starting/ending capital, absolute P&L,
return, trade count, wins/losses, win rate, gross profit/loss, fees, max
drawdown, peak equity, largest win/loss, max exposure) plus warnings/status.
The result is labelled a HISTORICAL SIMULATION — never a prediction of future
performance and never an indication of live-trading readiness.

### 39.7 Isolation

`runBacktest()` is a pure function of `(candles, config, factories)`: no wall
clock, no randomness, no network, no exchange adapter, no manual bridge, no
persistence store, no `PaperExecutionEngine`. It cannot place/cancel an order,
cannot create manual intents, cannot touch `ManagedStateStore`/paper/live state,
and cannot read or modify credentials.

### 39.8 Validation

`npm test` → 66 files (added 4 backtest files / 63 backtest tests). `npm run
typecheck`, `npm run lint`, `npm run build` all clean. `supportsOrderPlacement`
remains `false`; no SendOrder/CancelOrder; no live/paper/manual boundary change;
no `.env` change; nothing committed or pushed.

## 40. V1 Readiness review — acknowledged limitations & remediation (2026-09-06)

**Decision:** The V1 Readiness review concluded **V1 READY WITH DOCUMENTED
LIMITATIONS** (no P0/P1). The PAPER-first V1 is complete and safe; autonomous
NDAX LIVE remains disabled. The following are explicitly acknowledged known
limitations, not defects, and do **not** invalidate the PAPER-first V1:

- **Candle-series freshness is not age-checked at decision time.** The strategy
  decision path checks ticker/quote freshness (quote age, transport age,
  future-skew) but does **not** age-check the candle series the strategy
  evaluates. A strategy could theoretically evaluate a stale candle series while
  the ticker is fresh enough for risk approval. This is a **P2 LIVE-readiness**
  limitation — **not** a demonstrated PAPER-soak failure (the soak's 22
  `STALE_MARKET_DATA` events were ticker/quote-freshness rejections). It must be
  addressed before autonomous NDAX LIVE could be considered.
- **V0/V1 reconciliation coexist.** V1 (`reconcile()`/`commitProven()`) is used
  by `bot reconcile`; V0 (`ReconcileService`/`Reconciler`) is used by some
  live-test/live-engine paths. Behavioral difference: V1 **surfaces** unexpected
  external exchange balances; V0 iterates only expected currencies and does not
  surface them (neither auto-adopts). Known coexistence/observability limitation;
  unification is future work, not required for V1.

**Remediation applied (read-only review → F1–F3):** F1 closes the
`analyzeCompleteness` fail-open edge (a non-positive exchange executed quantity
with PROVEN executions is never `COMPLETE`); F2 makes the live/manual realm
distinguish genuine first-run from unexpected state loss via the
`StateInitMarker` (fail closed on loss); F3 wires the existing `recoverState`
cross-file consistency validation into the live/manual production startup gate
(`assertLiveRealmRecoverable`), which fails closed on HALTED state and on
cross-file contradictions (orphan reservation, accounted intent without a
settlement). `supportsOrderPlacement` remains `false`; no SendOrder/CancelOrder;
no PAPER/LIVE/manual boundary change; no `.soak` change; nothing committed.
