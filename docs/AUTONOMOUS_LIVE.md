# Autonomous LIVE runbook (NDAX)

This is the operator procedure for running the bot **unattended against a real
NDAX account**. It is the highest-risk mode the project supports. Read the whole
document before arming anything.

> **REAL FUNDS.** The autonomous engine places real orders with real money and
> does not ask for per-trade confirmation. It fails closed on uncertainty, but
> it can still lose money. There is no guarantee of profitability.

## 0. What the autonomous engine does

- Runs the same **Strategy → RiskManager → multi-asset Coordinator** pipeline as
  PAPER, but routes the single selected trade per cycle to NDAX via
  `LiveOrderEngine`.
- Executes **LIMIT + IOC only** (never rests on the book). Price is taken from
  the risk-approved reference (ask for BUY, bid for SELL), bounded by
  `LIVE_MAX_BASE_QUANTITY` and `LIVE_MAX_QUOTE_NOTIONAL`, and by a **session
  budget** (`LIVE_AUTONOMOUS_MAX_SESSION_QUOTE_NOTIONAL` /
  `LIVE_AUTONOMOUS_MAX_SESSION_ORDERS`) and expiry
  (`LIVE_AUTONOMOUS_SESSION_MINUTES`).
- Holds **at most one unresolved live order**; it does not place a new order
  until the prior one is resolved.
- **Reconciles every cycle** (`reconcile()` + `commitProven()` + the read-only
  `LiveOrderMonitor`) and applies only PROVEN, quote-fee fills.
- **Halts new placement** (while continuing to observe/account) on: reconciliation
  `HALTED`, any exchange read failure, an `UNKNOWN` submission, the kill switch,
  or repeated cycle errors.
- Enforces the `RiskManager` limits (max position/exposure, daily loss,
  drawdown, cooldown, max open positions) and a stale-candle/stale-quote
  fail-closed decision path.

`NdaxAdapter.capabilities.supportsOrderPlacement` **remains false**. The engine
places orders through an explicit, process-local **autonomous session** object
that is minted only by `bot start` when all arming conditions hold and is
consumed per order at the exchange mutation boundary.

## 1. Arming prerequisites (all required)

`.env`:

```dotenv
TRADING_MODE=live
REAL_FUNDS_AT_RISK=true
ENABLE_AUTHENTICATED_READS=true
KILL_SWITCH=false
EXCHANGE=ndax
TRADING_PAIRS=BTC/CAD            # exactly one pair
UNIVERSE_MARKETS=BTC/CAD,...     # the curated universe you approve
LIVE_AUTONOMOUS_ENABLED=true
LIVE_MAX_BASE_QUANTITY=...        # per-order cap
LIVE_MAX_QUOTE_NOTIONAL=...       # per-order cap
LIVE_AUTONOMOUS_MAX_SESSION_QUOTE_NOTIONAL=...
LIVE_AUTONOMOUS_MAX_SESSION_ORDERS=...
LIVE_AUTONOMOUS_SESSION_MINUTES=...
```

Config validation refuses to start if `LIVE_AUTONOMOUS_ENABLED=true` without
`TRADING_MODE=live`, `REAL_FUNDS_AT_RISK=true`, and
`ENABLE_AUTHENTICATED_READS=true`.

## 2. Pre-flight (read-only; do this every time)

- [ ] `git status --short` — know the exact revision under review.
- [ ] No other bot process: `pgrep -af 'dist/index.js|src/index.ts|tsx'`.
- [ ] No stale mutation lock: `ls -la .state/.mutation.lock` (must be absent;
      if present follow `CREATED_ORDER_RECOVERY.md`).
- [ ] `node dist/index.js config` → mode `LIVE`, kill switch `false`, one pair.
- [ ] `node dist/index.js trades --open` → no unresolved live orders.
- [ ] `node dist/index.js live-test buy --check` → ends `BUY PREFLIGHT: READY`
      (read-only; this exercises the same gates/reads).
- [ ] `node dist/index.js reconcile` → no actionable findings (unresolved
      orders/reservations/operator findings, ambiguous attribution, managed-CAD
      mismatch). Global `RECONCILIATION_REQUIRED` for historical/external
      `UNCORRELATED` executions alone does not block.
- [ ] Managed CAD matches exchange available CAD (adopt pre-existing external
      cash first via `live-adopt-external-cash` if needed — see
      `FIRST_LIVE_BUY.md` §0.1).
- [ ] `npm run verify:ndax` → all read-only checks pass.
- [ ] Confirm the session caps are the size you actually intend to risk.

## 3. Start (foreground, first time)

```bash
npm run build
node dist/index.js start --confirm-live
```

The engine prints a loud arming banner and starts. Ctrl-C stops it gracefully
(revoking the session). Watch the first cycles: `NO TRADE` is normal and correct
until the strategy signals.

## 4. Stop / kill

- Graceful: `Ctrl-C` (foreground) or
  `systemctl --user stop cryptotradingbot-live.service`.
- Hard stop: set `KILL_SWITCH=true` and restart, or stop the process. A killed
  process leaves durable state; on restart the engine reconciles before trading.

## 5. Operating as a service

Install the `deploy/systemd/cryptotradingbot-live.service` user unit (see the
header of that file). It runs `bot start --confirm-live`, has `Restart=no` (a
crash requires human review of ambiguous orders), and confines writes to
`.state/`.

## 6. Monitoring

- Dashboard: `node dist/index.js dashboard` (loopback only; see
  `DASHBOARD_DEPLOYMENT.md`). The Engine panel shows heartbeat, running/halted,
  orders placed, managed equity, and the equity curve. LIVE portfolio/P&L and the
  live order lifecycle are on the Portfolio/Orders panels.
- Alerts (optional): set `ALERT_WEBHOOK_URL` and/or `ALERT_NTFY_TOPIC` to be
  notified of `UNKNOWN` orders, halts, kill switch, and repeated cycle errors.
- Heartbeat/equity files: `.state/engine-status.json`,
  `.state/equity-history.jsonl`.

## 7. Handling an UNKNOWN order (DO NOT RETRY)

An `UNKNOWN` submission halts new placement. Do not retry, and do not assume an
absence from OpenOrders means the order never existed.

```bash
node dist/index.js trades --open
node dist/index.js reconcile
node dist/index.js live-monitor            # read-only observer
node dist/index.js resolve-live-order <clientOrderId> --order-id <exchangeOrderId> \
  --operator <name> --accounting-authority operator_attestation --confirm
```

A `CREATED` / `SUBMITTED`-without-id / `UNKNOWN`-without-id order is resolved via
`resolve-created-order` (ATTACH/ABANDON). See `CREATED_ORDER_RECOVERY.md`.

## 8. Do NOT

- Do not run the autonomous engine without reviewing the preflight each session.
- Do not widen caps or disable the session budget to "make it trade".
- Do not cancel the session and re-run repeatedly in the same minute.
- Do not run PAPER and LIVE units against the same state files.
- Do not edit `.state` to force a reconciliation pass.
- Do not treat `ACCEPTED` as `FILLED`; only PROVEN + QUOTE fills are accounted.

## 9. Known limitations

- NDAX `SendOrder` is asynchronous (ack ≠ on-book) and `CancelOrder` is
  receipt-only; lifecycle is confirmed by reconciliation.
- Exactly-once execution accounting is **not** claimed; the execution identity is
  not proven universally unique. Accounting is fail-closed; operator attestation
  is never exchange-proven provenance.
- NDAX has no official testnet; the first real order is the empirical placement
  test. Prefer the controlled `live-test buy|sell` first (see
  `FIRST_LIVE_BUY.md`).
