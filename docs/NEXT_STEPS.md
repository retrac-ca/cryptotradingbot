# Next steps — handoff notes

_Last updated: 2026-10-17. Main branch `main`._

This is the pick-up-here note. It records where the project stands and exactly
what is left. Update it (or delete it) as things move.

## TL;DR

The **code is complete** at `v1.4.0` and fully green, and the PAPER + dashboard
systemd deployment is installed and healthy (see §0.1). The only remaining work
is **operational validation against a real NDAX account** (see §2), which
requires the account owner and real funds. There is also one
intentionally-unresolved, documented limitation (§3).

## 0. Verify the current state (read-only, ~1 min)

```bash
git switch main && git pull
npm ci
npm run typecheck && npm run lint && npm test && npm run build
```

Expected: typecheck/lint/build clean; `npm test` → **127 files / 1656 tests**.

### 0.1 Current environment snapshot (2026-10-17)

- The user units `cryptotradingbot-paper.service` and
  `cryptotradingbot-dashboard.service` are installed from `deploy/systemd/`
  (byte-identical to the repo), **enabled**, and **active**; `loginctl` linger
  is **yes**. `systemd-analyze --user verify` is clean and the journals show no
  warnings.
- The dashboard is bound to `127.0.0.1:8787`; `/api/health` reports NDAX
  **connected** with authenticated reads enabled from this environment.
- A PAPER soak is running under systemd (~9,829.94 CAD paper cash, 44 recorded
  paper orders, 0 restarts since the current start). The `.state/` heartbeat and
  equity curve are live. `bot healthcheck` reports **HEALTHY** (5/5).
- `LIVE_AUTONOMOUS_ENABLED=false` in `.env` (disarmed during the handoff —
  see §4). The LIVE systemd unit is deliberately **not** installed.
- Read-only LIVE preflight on 2026-10-17: `live-test buy --check` ends
  **BUY PREFLIGHT: READY** (reconciliation `RECONCILIATION_REQUIRED` only from
  historical UNCORRELATED executions; pre-trade BUY gate **ALLOWED**);
  `verify:ndax` passes all 10 read-only checks (public + authenticated reads,
  fee-product resolution); `trades --open` = 0; no mutation lock. The only
  actionable-looking reconcile line is an **external ADA balance** finding; it
  does not block the BUY pre-trade gate — treat it as external inventory and do
  not adopt it without a deliberate ownership decision.

## 1. What is done

- **Autonomous LIVE engine** (`src/engine/LiveEngine.ts`) — bounded, explicitly
  armed (`LIVE_AUTONOMOUS_ENABLED=true` + `--confirm-live`), LIMIT+IOC, one order
  in flight, per-cycle reconcile/account, fail-closed halts
  (`docs/AUTONOMOUS_LIVE.md`).
- **Monitoring** — engine heartbeat + equity curve for **paper and live**
  (`.state/engine-status.json`, `.state/equity-history.jsonl`), read-only
  dashboard Engine panel (`/api/engine`, `/api/equity`), optional webhook/ntfy
  alerts.
- **Single reconciliation path** — legacy V0 removed; V1
  (`reconcile()`/`commitProven()` + `livePreTradeGate`) is the only path and now
  surfaces unexpected external balances everywhere (`docs/DECISIONS.md` §47–§48,
  `docs/RECONCILIATION_UNIFICATION.md`).
- Controlled `live-test buy|sell`, manual bridge, backtesting, P2 candle
  freshness, F-8 managed-valuation bound, CI (`.github/workflows/ci.yml`),
  systemd units (`deploy/systemd/`), and the PAPER + dashboard user units
  installed and running (§0.1).
- **Operations tooling** — read-only `bot healthcheck` (state recovery, mutation
  lock, heartbeat, equity curve, dashboard liveness) and `bot backup-state`
  (timestamped snapshots + retention), plus healthcheck/backup systemd timers in
  `deploy/systemd/`. See `docs/OPERATIONS.md`.

Recent PRs (all merged, CI green): #1 autonomous engine + monitoring (v1.3.0),
#2 paper heartbeat fix, #3 CI actions v7, #4 reconciliation plan, #5 remove V0,
#6 next-steps handoff note. This branch adds the v1.4.0 accuracy pass + operations
hardening (health check, backups, docs); it is not merged yet.

## 2. What is left — operational (needs the live NDAX account + explicit go)

Do these in order. Nothing here is automated.

1. **Paper soak** — confirm stability before touching live. A systemd paper soak
   is already running (§0.1); inspect it with:
   ```bash
   systemctl --user status cryptotradingbot-paper.service
   journalctl --user -u cryptotradingbot-paper.service -f
   # or a manual foreground run instead:
   npm run build && npm start -- paper   # Ctrl-C to stop; state persists
   ```
   Dashboard: <http://127.0.0.1:8787> → Engine panel (heartbeat + equity curve).
   Health: `node dist/index.js healthcheck --require-engine` (exit 0 = healthy;
   see `docs/OPERATIONS.md`).
2. **First controlled LIVE BUY** — follow `docs/FIRST_LIVE_BUY.md` exactly:
   ```bash
   node dist/index.js live-test buy --check     # read-only; must end "BUY PREFLIGHT: READY"
   # then the real, operator-confirmed single order:
   node dist/index.js live-test buy --confirm-live   # type EXECUTE at the prompt
   ```
   `ACCEPTED != FILLED`. Account a fill only when it is PROVEN + QUOTE
   (`node dist/index.js reconcile`).
3. **Bounded autonomous session** — only after 1–2 are clean. Read
   `docs/AUTONOMOUS_LIVE.md` first, then arm with deliberately small caps and
   `node dist/index.js start --confirm-live`.
4. **Deploy + monitor** — the PAPER and dashboard units are already installed
   and running (§0.1). Remaining optional pieces: install the healthcheck and
   backup timers from `deploy/systemd/` (see `docs/OPERATIONS.md`), set
   `ALERT_WEBHOOK_URL` / `ALERT_NTFY_TOPIC`, and (if remote access is wanted)
   front loopback with Tailscale per `docs/DASHBOARD_DEPLOYMENT.md`. The **LIVE**
   unit stays uninstalled until unattended real-money trading is deliberately
   wanted.
5. **Backups** — run `node dist/index.js backup-state` once and enable the daily
   timer. Snapshots default to `.state-backups/` (git-ignored) and retain 14;
   restore steps are in `docs/OPERATIONS.md` §2.

If an order reports **UNKNOWN**: **do not retry**. See
`docs/AUTONOMOUS_LIVE.md` §7 and `docs/CREATED_ORDER_RECOVERY.md`.

## 3. Intentionally not done (documented limitation, not a bug)

- **Universal fee/capital accounting completeness.** NDAX order-level
  `getOrderStatus` reports `feeCurrency: 'unknown'`, so the **order-level** fee
  currency is not derivable from that read. Fee currency is resolved at the
  **execution** level from `AccountTrade.feeProductId` via
  `resolveFeeCurrency` (live-verified); a PROVEN + QUOTE fee is auto-accounted,
  while BASE/OTHER/UNKNOWN fees correctly fail closed to
  `RECONCILIATION_REQUIRED`. What remains deferred is Model C universal
  execution-level accounting (unproven `executionId` uniqueness and complete
  per-order enumeration). See `docs/DECISIONS.md` §33–§36, §40; this is a
  documented limitation, not a defect.

## 4. Heads-up

- **`.env` is a real-money configuration, not a paper one.** As of 2026-10-17 it
  sets `TRADING_MODE=live`, `REAL_FUNDS_AT_RISK=true`,
  `ENABLE_AUTHENTICATED_READS=true`, and `KILL_SWITCH=false`. The only thing
  keeping autonomous trading off is `LIVE_AUTONOMOUS_ENABLED=false` (set during
  this handoff). Re-arming needs only that flag plus `--confirm-live` (or an
  enabled LIVE unit), so treat `.env` edits accordingly.
- The running `paper` unit is still safe: `bot paper` forces PAPER mode
  regardless of `TRADING_MODE`.
- Never commit `.env` or `.state/` (both git-ignored).

## 5. Key docs

`README.md` · `docs/ARCHITECTURE.md` (component map + phase table) ·
`docs/DECISIONS.md` (design record; most recent decisions are at the end) ·
`docs/AUTONOMOUS_LIVE.md` · `docs/FIRST_LIVE_BUY.md` · `docs/NDAX_API.md` ·
`docs/CREATED_ORDER_RECOVERY.md` · `docs/DASHBOARD_DEPLOYMENT.md` ·
`docs/OPERATIONS.md`.
