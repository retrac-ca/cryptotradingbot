# First controlled LIVE BUY — operator runbook

This is the operator procedure for the first real-money BUY via
`bot live-test buy`. It is **read-only-verifiable** at every step except the
single confirmed submission. Do not retry, and never run the submission command
until the pre-flight is green.

> The bot has **no autonomous live trading**. `bot live-test buy` is the only
> production BUY path. It is LIMIT-only, side-scoped, single-use-authorized,
> persist-before-submit, mutation-locked, and requires an interactive `EXECUTE`.

## 0. What is deliberately NOT available

- No `--quantity`, `--price`, or `--target-cad` for BUY. The size/price are
  derived by the RiskManager and the market snapshot.
- No cancel command for the controlled live path. A resting live LIMIT cannot be
  cancelled by the bot.
- Managed CAD comes from a prior controlled SELL settlement (or manual
  settlement), or from an explicit ownership adoption of pre-existing external
  quote cash via `bot live-adopt-external-cash` (see §0.1). `bot
  live-onboard-external` authorizes **base** inventory only.

### 0.1 Adopting pre-existing external CAD as managed capital

If the exchange holds quote cash the bot does not yet manage (e.g. CAD that
predated the bot), the global `reconcile` reports a managed-CAD mismatch, which
blocks a BUY. To resolve it legitimately, the operator may adopt that external
cash as bot-managed deployable capital:

```bash
# LIVE realm + ENABLE_AUTHENTICATED_READS; read-only exchange verification +
# interactive `ADOPT`; local ownership change only (never places/cancels).
npm run dev -- live-adopt-external-cash
```

It adopts exactly `exchange available − managed cash` (`ADOPT` attestation,
TOCTOU re-read), never more than the verified exchange balance. **This makes
that quote DEPLOYABLE real capital at risk** — a deliberate ownership decision,
not a way to "force" reconciliation green. After it, `bot reconcile` shows no
managed-CAD mismatch (unrelated external *assets* may still be informational).

### 0.2 Authorizing other external base assets

Pre-existing external crypto (e.g. ETH/ADA/DOT/…) can be brought under bot
management/tracking — clearing their informational reconcile findings — with the
same verified-quantity + interactive `AUTHORIZE` machinery:

```bash
npm run dev -- live-onboard-external --symbol ETH/CAD
```

`--symbol` selects the asset; omit it to onboard the configured pair's base
(original behavior). The amount is always derived from the authoritative
exchange balance (no quantity/`--yes`/`--force`), and each asset is a separate
explicit operator decision. Authorized assets become `EXTERNAL_AUTHORIZED`
(zero cost basis) and are valued at BUY time via `getTicker`; every asset must
have a live `*/CAD` market or the BUY valuation fails **closed**.


## 1. Command syntax

From the repository root (`.env` is read from the current directory):

```bash
# Recommended: runs the reviewed TypeScript source directly (dist may be stale).
npm run dev -- live-test buy --confirm-live

# Or, after `npm run build`:
node dist/index.js live-test buy --confirm-live
```

Required: `TRADING_MODE=live`, `REAL_FUNDS_AT_RISK=true`, `KILL_SWITCH=false`,
`ENABLE_AUTHENTICATED_READS=true`, exactly one `TRADING_PAIRS` entry,
`LIVE_MAX_BASE_QUANTITY>0`, `LIVE_MAX_QUOTE_NOTIONAL>0`, and `--confirm-live`.

## 2. How size and price are determined

- Price = `ticker.ask ?? ticker.last` (BUY). Always a LIMIT order; TIF defaults
  to GTC.
- `desiredNotional` = smallest remaining of: the per-asset position cap
  (`MAX_POSITION_SIZE_FRACTION` × portfolio value − current position), the
  portfolio-exposure cap, and `MAX_TRADE_AMOUNT` (if > 0).
- `quantity = floor(desiredNotional / price, quantityTick)`; rejected if it
  rounds to zero, is below `minOrderBase`, or is off the tick grid.
- Engine hard ceilings: `quantity <= LIVE_MAX_BASE_QUANTITY` and
  `notional + fee <= LIVE_MAX_QUOTE_NOTIONAL`.
- Funding: `notional + fee <= deployableQuote = min(managed CAD, exchange
  available CAD) − reserved`.

Because the operator cannot choose a size, the first BUY size is whatever the
binding cap yields. To bound it deliberately, configure a small
`MAX_TRADE_AMOUNT` and a suitable `MAX_POSITION_SIZE_FRACTION`; to *raise* the
allowed size you must widen those caps (a deliberate risk decision, not a
workaround).

## 3. Pre-flight checklist (read-only; any failure = STOP)

- [ ] `git status --short` — know the exact revision under review.
- [ ] No concurrent bot: `pgrep -af 'dist/index.js|src/index.ts|tsx'`.
- [ ] No mutation lock: `ls -la .state/.mutation.lock` (must be absent; if
      present follow the stale-lock step in `CREATED_ORDER_RECOVERY.md`).
- [ ] `npm run dev -- config` → `LIVE`, `Kill switch=false`, one pair.
- [ ] `.env`: `ENABLE_AUTHENTICATED_READS=true`; note `MAX_OPEN_POSITIONS`,
      `MAX_POSITION_SIZE_FRACTION`, `MAX_TRADE_AMOUNT`, the LIVE caps.
- [ ] `npm run dev -- trades --open` → no unresolved live orders.
- [ ] `npm run dev -- live-test buy --check` → reviews the live BUY preflight
      read-only and ends with `BUY PREFLIGHT: READY` (see §3.2). This is the
      authoritative BUY preflight; it never places an order.
- [ ] `npm run dev -- reconcile` (read-only) → no **actionable** findings: no
      unresolved `[order]` / `[res]` / `[operator]`, no managed-CAD `[bal]`
      mismatch, no `AMBIGUOUS` / `STRONG_BUT_NOT_PROVEN` attribution, and no
      unsafe (non-`QUOTE`) fee on a `PROVEN` execution. Historical/external
      `UNCORRELATED` executions are informational and do NOT block a BUY (§3.1),
      so the global status may legitimately read `RECONCILIATION_REQUIRED` for
      that reason alone. BUY is gated by the action-aware pre-trade gate, not by
      the global `READY` string.
- [ ] `Proven to commit: 0` unless you have a separately reviewed reason to
      commit (never commit to force ambiguous accounting — see §5).
- [ ] Read-only NDAX probe (never places orders): `npm run verify:ndax` → all
      checks pass and market metadata loads for BTC/CAD (confirms connectivity
      and the exchange's min-order/tick constraints before the BUY).
- [ ] Managed CAD > 0 and it matches exchange available CAD.
- [ ] Number of managed open positions < `MAX_OPEN_POSITIONS` (a BUY that ADDS to
      an already-managed symbol is not counted as a new position).
- [ ] The derived size will be above the exchange minimum (review the caps).

### 3.1 Action-aware BUY gating — what blocks and what does not

For BUY, the pre-trade projection (`livePreTradeGate`) is **action-aware**: it
does not require the *global* reconcile status to be `READY`, but it still blocks
every actionable finding.

**Acceptable (informational — do NOT block BUY):**

- `UNCORRELATED` historical executions (no local bot order attribution to a bot
  order). These are external/historical activity the bot does not account and
  does not own; they are not, by themselves, a BUY or SELL blocker.
- External-asset findings that do not represent managed-CAD spend.

**Blocking (any one = STOP):**

- unresolved `[order]` (any disposition other than `CONFIRMED` /
  `PARTIALLY_CONFIRMED`);
- unresolved `[res]` (ambiguous reservation), or any orphan reservation;
- unresolved `[operator]` / cross-domain finding;
- managed CAD `[bal]` mismatch;
- `AMBIGUOUS` execution attribution;
- `STRONG_BUT_NOT_PROVEN` execution attribution;
- a `PROVEN` execution whose fee disposition is not `QUOTE` (unsafe / `BASE` /
  `UNKNOWN` / `MALFORMED`) where accounting cannot safely proceed;
- any BUY readiness blocker (mode/funds/kill switch/auth reads/freshness/
  valuation/risk/quantity/price/exchange-quote/managed-CAD/fee), or an
  unresolved live order;
- zero or absent **MANAGED** deployable CAD. The exchange CAD total is never
  treated as deployable; external/unmanaged CAD is never deployed.

### 3.2 Read-only preflight: `npm run dev -- live-test buy --check`

```bash
npm run dev -- live-test buy --check
```

`--check` runs the **same** BUY preflight as the real command — pre-contact
gates, the live market/account snapshot, managed-only risk context, V1
reconciliation, the action-aware pre-trade gate, and BUY readiness — and then
**stops before authorization/execution**. It prints the summary plus a
categorised verdict separating **blocking failures**, **informational findings**,
and **compensating controls / permanent limitations**, ending in exactly
`BUY PREFLIGHT: READY` or `BUY PREFLIGHT: BLOCKED`. It exits `0` only when the
BUY is genuinely ready and non-zero otherwise.

`--check` does **not** require `--confirm-live` (confirmation is a later human
step of the real BUY). `--check` **cannot**:

- mint a usable controlled-live authorization;
- create, prepare, reserve, or persist an order/reservation;
- call `placeOrder` or NDAX `SendOrder`;
- prompt for `EXECUTE`; or
- mutate `.state`.

It may perform the same authenticated **read-only** exchange reads the real BUY
does. It is the safe way to review the preflight end-to-end without any
possibility of submitting.

## 4. Confirmation

The command prints the full summary and then:

```
This will submit a LIMIT BUY on the LIVE NDAX account:
  SIDE:          BUY
  TYPE:          LIMIT
  symbol:        BTC/CAD
  quantity:      <qty> BTC
  limit price:   <price> CAD
  notional:      <notional> CAD
  time in force: GTC (default)
Type EXECUTE and press Enter to place this EXACT order, or anything else to abort.
```

Type exactly `EXECUTE` (case-insensitive, trimmed) to submit. Anything else
aborts. `stdin` must be a TTY.

Before confirming, independently verify: symbol, `BUY`, `LIMIT`, quantity, limit
price, notional, TIF, `TOTAL CAD REQUIRED <= MANAGED/DEPLOYABLE CAD`,
`Market-data freshness: FRESH`, pre-trade gate `ALLOWED`, `BUY READINESS:
READY`, and all gates `[PASS]`. Record all of these values before submitting.

## 5. After submission

`ACCEPTED != FILLED`. Observe read-only; then account only PROVEN + QUOTE fills.

```bash
npm run dev -- trades
npm run dev -- trades --open
npm run dev -- reconcile            # read-only
npm run dev -- reconcile --commit   # MUTATES local state; only when READY + proven commits
```

A fill is proven only when account trades correlate PROVEN to the order with a
QUOTE fee (`completeness=COMPLETE`). BASE/UNKNOWN/MALFORMED fee or ambiguous
correlation fails closed and requires operator attestation:

```bash
npm run dev -- resolve-live-order <clientOrderId> --order-id <exchangeOrderId> \
  --operator <name> --accounting-authority operator_attestation --confirm
```

### 5.1 Accounting language (proven vs attested)

- `PROVEN` execution evidence may already exist for prior/attested activity
  (for example, the three prior controlled LIVE SELLs). A `PROVEN` finding means
  the account trade correlates to a local bot order with a valid QUOTE fee — it
  is the only auto-accountable case.
- An **operator-attested** order is **not** automatically equivalent to fully
  proven execution provenance. An attestation records who asserted the
  OrderId/fill (`provenanceProof` is always `false`) and resolves only that
  specific order; it never upgrades to exchange-proven provenance.
- `commitProven` **must not double-account** an execution already represented by
  an attested resolution. The orchestrator enforces this: if an order already
  carries an operator attestation it refuses to also commit a PROVEN execution
  for the same order (fail closed).
- **Never** use `reconcile --commit` as a way to force ambiguous accounting.
  Commit applies only deterministic, PROVEN + QUOTE executions and safe
  reservation releases; `AMBIGUOUS` / `RECONCILIATION_REQUIRED` states are never
  forced into accounting by committing.

## 6. UNKNOWN / lost acknowledgement — DO NOT RETRY

If the command reports `submission outcome UNKNOWN` (or an ack with no OrderId),
or the process crashes after `CREATED`:

- **Do not retry. Do not assume absence from OpenOrders means it never existed.**
- The managed-CAD reservation is retained and the one-in-flight guard blocks
  further live orders.
- Inspect: `npm run dev -- trades --open`, `npm run dev -- reconcile`,
  `npm run dev -- live-monitor` (read-only observer), and the NDAX web UI.
- Resolve `CREATED` / `SUBMITTED`-without-id / `UNKNOWN`-without-id with:

```bash
# ATTACH the exact exchange OrderId (verified read-only), or:
npm run dev -- resolve-created-order <clientOrderId> \
  --operator <name> --attach-exchange-order-id <exchangeOrderId> --confirm

# ABANDON the local record (NOT proof no exchange order exists):
npm run dev -- resolve-created-order <clientOrderId> \
  --operator <name> --abandon --reason "<reason>" --confirm
```

An `UNKNOWN`/`SUBMITTED` order **with** an `exchangeOrderId` is handled by
`live-monitor` / `resolve-live-order`, not by `resolve-created-order`.

## 7. Do NOT

- Do not retry/resend after a refusal, rejection, timeout, or UNKNOWN.
- Do not change price or quantity to force a fill (no such flags exist).
- Do not attempt to cancel via an unvetted exchange action.
- Do not SELL to compensate or run another BUY.
- Do not restart into `bot start --confirm-live` (it refuses).
- Do not edit/delete `.state`, reservations, the ledger, or `.env` to force a pass.
- Do not bypass readiness/gates/confirmation or automate the `EXECUTE` prompt.
- Do not treat an accepted order as filled, or OpenOrders presence/absence as proof.
- Do not force accounting when execution/fee evidence is ambiguous.

## 8. Stop conditions

Stop immediately (do not place/modify) on: any pre-contact gate FAIL; any
readiness blocker; pre-trade gate BLOCKED; stale snapshot; `MAX_OPEN_POSITIONS`;
`BELOW_MIN_QUANTITY`/`PRECISION_VIOLATION`; `INSUFFICIENT_BALANCE`; risk
rejection; authorization/reservation/persistence failure; `UNKNOWN` submission;
missing OrderId; unexpected open order/reservation; ambiguous execution/fee
evidence; a held mutation lock; or a crash after `CREATED`. Escalate anything
not clearly safe.
