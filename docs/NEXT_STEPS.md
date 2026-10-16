# Next steps — handoff notes

_Last updated: 2026-10-16. Main branch `main`._

This is the pick-up-here note. It records where the project stands and exactly
what is left. Update it (or delete it) as things move.

## TL;DR

The **code is complete** at `v1.3.0` and fully green. The only remaining work is
**operational validation against a real NDAX account** (see §2), which requires
the account owner and cannot be done from the dev environment (no NDAX network
access there). There is also one intentionally-unresolved, documented limitation
(§3).

## 0. Verify the current state (read-only, ~1 min)

```bash
git switch main && git pull
npm ci
npm run typecheck && npm run lint && npm test && npm run build
```

Expected: typecheck/lint/build clean; `npm test` → **125 files / 1643 tests**.

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
  systemd units (`deploy/systemd/`).

Recent PRs (all merged, CI green): #1 autonomous engine + monitoring (v1.3.0),
#2 paper heartbeat fix, #3 CI actions v7, #4 reconciliation plan, #5 remove V0.

## 2. What is left — operational (needs the live NDAX account + explicit go)

Do these in order. Nothing here is automated.

1. **Paper soak** — confirm stability before touching live:
   ```bash
   npm run build
   npm start -- paper        # Ctrl-C to stop; state persists under .state/
   ```
   Watch the dashboard: `npm start -- dashboard` → open
   `http://127.0.0.1:8787` → Engine panel shows a heartbeat + equity curve.
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
4. **Deploy + monitor** — install the systemd units
   (`deploy/systemd/cryptotradingbot-*.service`), run the dashboard, and
   optionally set `ALERT_WEBHOOK_URL` / `ALERT_NTFY_TOPIC`.

If an order reports **UNKNOWN**: **do not retry**. See
`docs/AUTONOMOUS_LIVE.md` §7 and `docs/CREATED_ORDER_RECOVERY.md`.

## 3. Intentionally not done (documented limitation, not a bug)

- **Order-level NDAX fee currency.** `getOrderStatus` reports
  `feeCurrency: 'unknown'`, so an order-level NDAX fee cannot be authoritatively
  accounted; the manual bridge correctly fails closed to
  `RECONCILIATION_REQUIRED`. Resolving it needs execution-level accounting
  (Model C), which was deliberately deferred (unproven `executionId` uniqueness /
  per-order enumeration). See `docs/DECISIONS.md` §33–§36, §40.

## 4. Heads-up

- `.env` currently has **`LIVE_AUTONOMOUS_ENABLED=true`**. It still cannot arm
  without `TRADING_MODE=live` **and** `REAL_FUNDS_AT_RISK=true` **and**
  `ENABLE_AUTHENTICATED_READS=true` **and** `--confirm-live`. Set it to `false`
  if you did not intend paper-mode config to be live-armed.
- Never commit `.env` or `.state/` (both git-ignored).

## 5. Key docs

`README.md` · `docs/ARCHITECTURE.md` (component map + phase table) ·
`docs/DECISIONS.md` (design record; most recent decisions are at the end) ·
`docs/AUTONOMOUS_LIVE.md` · `docs/FIRST_LIVE_BUY.md` · `docs/NDAX_API.md` ·
`docs/CREATED_ORDER_RECOVERY.md` · `docs/DASHBOARD_DEPLOYMENT.md`.
