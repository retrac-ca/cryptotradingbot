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
- No managed-CAD onboarding command. Managed CAD comes from a prior controlled
  SELL settlement (or manual settlement). `bot live-onboard-external` authorizes
  **base** inventory only.

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
- [ ] `npm run dev -- reconcile` → `READY`, `Proven to commit: 0`, no
      `[order]`/`[res]`/`[operator]` findings, no CAD `[bal]` mismatch.
- [ ] Read-only NDAX probe (never places orders): `npm run verify:ndax` → all
      checks pass and market metadata loads for BTC/CAD (confirms connectivity
      and the exchange's min-order/tick constraints before the BUY).
- [ ] Managed CAD > 0 and it matches exchange available CAD.
- [ ] Number of managed open positions < `MAX_OPEN_POSITIONS` (a BUY that ADDS to
      an already-managed symbol is not counted as a new position).
- [ ] The derived size will be above the exchange minimum (review the caps).

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
