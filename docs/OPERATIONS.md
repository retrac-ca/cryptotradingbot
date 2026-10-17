# Operations runbook

This document covers the day-to-day operational layer: health checks, state
backups, restore, and the systemd timers. It does **not** authorize trading.
Real-money steps remain in `docs/FIRST_LIVE_BUY.md` and
`docs/AUTONOMOUS_LIVE.md`, and always require the operator.

Both commands below are **read-only with respect to trading state**:

- `bot healthcheck` reads local files and probes the local dashboard.
- `bot backup-state` copies local files; it never modifies, truncates, or
  deletes a state file, never contacts NDAX, and never acquires the mutation
  lock (so it cannot block the engine).

## 1. Health check

```bash
npm start -- healthcheck
# or, during development:
npm run dev -- healthcheck
```

Example (healthy deployment):

```text
Healthcheck: HEALTHY (5 pass, 0 warn, 0 fail)
  [PASS] state-recovery: state is present and consistent
  [PASS] mutation-lock: absent
  [PASS] engine-heartbeat: kind=paper age=12s running=true
  [PASS] equity-history: latest equity=10000.00000000 age=12s
  [PASS] dashboard: http://127.0.0.1:8787/api/healthz reachable
```

Checks:

| Check | What it verifies | Typical failure |
| --- | --- | --- |
| `state-recovery` | Fail-closed parse/consistency of paper, live-managed, order-ledger, and manual-intent state; unresolved orders/reservations/intents; unexpected state loss | `CORRUPT` / `HALTED`; run `bot reconcile` and the operator recovery docs |
| `mutation-lock` | `.state/.mutation.lock` is absent | A mutation is in progress, or a stale lock needs the documented manual procedure |
| `engine-heartbeat` | Heartbeat exists, is recent, and the engine is not halted | Engine stopped, crashed, stale, or halted |
| `equity-history` | The equity curve has recent valid samples | No samples yet, or no recent samples |
| `dashboard` | Local `/api/healthz` responds (HTTP only; **does not** call NDAX) | Dashboard not running or not listening |

Options:

```text
--json                       machine-readable output
--require-engine             missing/stale heartbeat is FAIL (not WARN)
--require-dashboard          unreachable dashboard is FAIL (not WARN)
--no-dashboard               skip the dashboard probe
--dashboard-url <url>        probe this base URL instead of loopback
--max-heartbeat-age-ms <n>   staleness threshold
                             (default: 5 x EVALUATE_INTERVAL_SECONDS, minimum 120s)
```

Exit codes: `0` healthy, `2` degraded/unhealthy, `1` error. Use `--require-engine`
in unattended checks so a stopped engine cannot masquerade as a healthy one.

> `healthcheck` deliberately does not verify exchange connectivity. Use the
> dashboard's `/api/health` or `npm run verify:ndax` for that explicit,
> read-only exchange check.

### systemd timer

`deploy/systemd/cryptotradingbot-healthcheck.service` + `.timer` run the check
every five minutes.

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/cryptotradingbot-healthcheck.* ~/.config/systemd/user/
npm run build
systemctl --user daemon-reload
systemd-analyze --user verify ~/.config/systemd/user/cryptotradingbot-healthcheck.service
systemctl --user start cryptotradingbot-healthcheck.service   # one-shot, verify output
journalctl --user -u cryptotradingbot-healthcheck.service -n 30
systemctl --user enable --now cryptotradingbot-healthcheck.timer
systemctl --user list-timers cryptotradingbot-healthcheck.timer
```

A failed run marks the service failed; inspect with:

```bash
systemctl --user --failed
journalctl --user -u cryptotradingbot-healthcheck.service -n 100
```

If you do not run the dashboard, add `--no-dashboard` to `ExecStart=` so the
missing dashboard is not reported as a degraded deployment.

## 2. State backup

```bash
npm start -- backup-state
# default destination: sibling of STATE_DIR, e.g. .state-backups/
```

Each snapshot is a directory named `state-<UTC timestamp>/` containing:

- every regular file from `STATE_DIR` (state envelopes, init marker, equity
  history, …);
- `manifest.json` with the creation time, source directory, file sizes, and
  skipped entries.

It skips `.mutation.lock` and `*.tmp`. The default snapshot directory is never
inside `STATE_DIR` (the command refuses that), is created with mode `0700`, and
is git-ignored.

Options:

```text
--dir <path>    backup directory (default: sibling "<STATE_DIR>-backups")
--keep <n>      snapshots to retain (default: 14)
--json          machine-readable output
```

Pruning removes only directories that both match `state-<timestamp>` and
contain a `manifest.json`. Unknown files/directories are never touched.

> A snapshot can span two engine cycles across files (state envelopes are
> individually atomic, but the copy is not a global transaction). That is fine
> for disaster recovery; do not treat a backup as an exchange reconciliation.

### systemd timer

`deploy/systemd/cryptotradingbot-backup.service` + `.timer` take one snapshot
daily at 03:30 local time (persistent across sleep/reboot).

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/cryptotradingbot-backup.* ~/.config/systemd/user/
npm run build
systemctl --user daemon-reload
systemd-analyze --user verify ~/.config/systemd/user/cryptotradingbot-backup.service
systemctl --user start cryptotradingbot-backup.service       # one-shot, verify output
systemctl --user enable --now cryptotradingbot-backup.timer
systemctl --user list-timers cryptotradingbot-backup.timer
```

If you change `--dir` in the unit, update `ReadWritePaths=` to match and keep
the destination outside `STATE_DIR`.

### Restore (operator procedure)

Never restore while an engine or dashboard is running, and never restore from a
snapshot you have not inspected.

1. Stop the engine (and dashboard for a fully quiet state directory):
   ```bash
   systemctl --user stop cryptotradingbot-paper.service cryptotradingbot-dashboard.service
   # add cryptotradingbot-live.service if it is installed
   ```
2. Confirm no bot process and no mutation lock:
   ```bash
   pgrep -af 'dist/index.js|src/index.ts|tsx'
   ls -la .state/.mutation.lock    # must be absent
   ```
3. Take a fresh safety snapshot of the current state (if it is readable):
   ```bash
   npm start -- backup-state --dir .state-backups-pre-restore
   ```
4. Copy the chosen snapshot's files back into `STATE_DIR`, **excluding**
   `manifest.json`; preserve `.init.json` and file permissions. For example:
   ```bash
   SNAP=.state-backups/state-2026-10-17T03-30-00-000Z
   cp -a "$SNAP"/. .state/
   rm -f .state/manifest.json
   ```
   Do not mix paper and live state files, and do not recreate missing files by
   hand: the init marker exists to detect state loss, and a missing initialized
   realm must fail closed.
5. Start the engine, then verify:
   ```bash
   systemctl --user start cryptotradingbot-paper.service cryptotradingbot-dashboard.service
   npm start -- healthcheck --require-engine
   npm start -- reconcile            # read-only; LIVE realm only
   ```
   For LIVE state, reconcile before allowing any new trading. If state is
   ambiguous or reconciliation is not READY, stop and follow
   `docs/CREATED_ORDER_RECOVERY.md`.

Backups contain portfolio/order metadata (no `.env` or API secrets are copied),
but treat them as sensitive account data: keep them private and never commit
them.

## 3. Soak review (before any real-money step)

```bash
systemctl --user status cryptotradingbot-paper.service cryptotradingbot-dashboard.service
journalctl --user -u cryptotradingbot-paper.service --since '24 hours ago' | grep -iE 'error|halt|corrupt'
npm start -- healthcheck --require-engine
```

Pass bar for the soak: no crash loop, no `HALTED`/corrupt state, a fresh
heartbeat, a growing equity curve, and no unexplained reconciliation findings.
Then follow `docs/FIRST_LIVE_BUY.md` for the controlled first BUY and
`docs/AUTONOMOUS_LIVE.md` for a bounded autonomous session. The first real order
and any autonomous arming are **explicit operator actions**; nothing in this
repository performs them automatically.

## 4. Useful commands

```bash
systemctl --user list-timers --all
systemctl --user --failed
journalctl --user -u cryptotradingbot-healthcheck.service -n 50
journalctl --user -u cryptotradingbot-backup.service -n 50
npm start -- healthcheck --json
npm start -- backup-state --json
```
