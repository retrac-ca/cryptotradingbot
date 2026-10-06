# Dashboard Deployment & Private Remote Access

This document describes how to run the **read-only** monitoring dashboard and
how to reach it privately from an authorized device (e.g. an iPhone) **without
exposing the monitoring API to the public internet**.

The dashboard is an operational/observational concern only. It is a separate
process from the trading bot and never places, cancels, resolves, or accounts
for orders.

```text
Authorized device (phone / laptop)
        │  Tailscale (device-authenticated, encrypted)
        ▼
Private access layer (tailnet)  ── no public listener, no public DNS
        │
        ▼
Dashboard process  ── systemd user unit, binds 127.0.0.1:8787 only
        │  GET only
        ▼
Read-only MonitoringService
        │
        ▼
Existing bot state / domain readers
```

## Environment this was designed for

- WSL2 (Ubuntu) on a Windows host; `systemd` is enabled and the **user**
  systemd manager is available.
- Node.js is installed at `/usr/bin/node`.
- No Docker, no Tailscale, and no cloudflared installed by default.
- WSL2 is in **NAT** networking mode, so LAN devices cannot reach the WSL
  instance directly.
- WSL contains no host firewall tooling; the effective boundary is the Windows
  Firewall plus the private access layer described below.

## 1. Build and run locally

```bash
npm run build                 # compiles the server AND dist/dashboard/
node dist/index.js dashboard  # binds 127.0.0.1:8787 by default
```

Open <http://127.0.0.1:8787/>. The JSON API is under `/api/*`.

Stop with `Ctrl-C`.

> The dashboard reads the project `.env` (for state paths and, for explicit
> `/api/health` and `/api/reconciliation`, the NDAX read credentials). Run it
> from the repository root, e.g. `WorkingDirectory` in the unit below.

## 2. Run as a persistent service (systemd user unit)

A unit is provided at `deploy/systemd/cryptotradingbot-dashboard.service`. It
starts **only** `bot dashboard` (never the trading bot) and keeps it on
loopback. Installing, enabling, starting, and lingering are **explicit operator
actions** — nothing here (or in the repository) does them automatically.

### 2.1 Build

```bash
npm run build          # produces dist/index.js and dist/dashboard/
```

### 2.2 Install

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/cryptotradingbot-dashboard.service ~/.config/systemd/user/
```

### 2.3 Reload and verify

```bash
systemctl --user daemon-reload
systemd-analyze --user verify ~/.config/systemd/user/cryptotradingbot-dashboard.service
```

`systemd-analyze --user verify` checks that the unit parses and that directives
are valid for the installed systemd version. It may emit advisory warnings for
directives the local systemd does not recognize; treat parse errors as blocking.

### 2.4 Enable and start

```bash
systemctl --user enable cryptotradingbot-dashboard.service
systemctl --user start  cryptotradingbot-dashboard.service
```

### 2.5 Stop a stale dashboard first

If a dashboard was started manually (or by an earlier, pre-hardening unit), it
already owns `127.0.0.1:8787` and the new service will fail to bind. Identify it
and stop it **before** starting the service:

```bash
pgrep -af 'dist/index.js dashboard'   # identify the process/PID
ss -ltnp | grep 127.0.0.1:8787        # confirm the listener
# then stop only that process (e.g. kill <PID>) — do not kill unrelated Node jobs
```

The unit does not, and must not, kill other processes.

### 2.6 Useful commands

```bash
systemctl --user status cryptotradingbot-dashboard.service
systemctl --user restart cryptotradingbot-dashboard.service
systemctl --user stop cryptotradingbot-dashboard.service
journalctl --user -u cryptotradingbot-dashboard.service -e
```

The unit refuses to start if `dist/index.js` is missing (`AssertPathExists`),
and restarts on failure (`Restart=on-failure`, `RestartSec=5`). It does **not**
depend on, or launch, the trading bot.

### 2.7 Filesystem sandbox (M2 process containment)

The dashboard is write-capable only in the narrow sense required by the existing
reconciliation code, which briefly creates/removes the shared mutation lock
`<repo>/.state/.mutation.lock`. The unit therefore sets:

```text
ProtectHome=read-only
ReadWritePaths=%h/code/cryptotradingbot/.state
```

`ProtectHome=read-only` makes the whole home directory (`/home/<user>`, `/root`,
`/run/user`) read-only to the service. The single `ReadWritePaths=` entry
re-grants write access **only** to the repository's `.state/` directory, so the
dashboard can create/remove its lock and any state files inside `.state/`, while
it cannot modify the repository, `dist/`, `web/`, `src/`, `.env`, `package.json`,
or the rest of the home directory. `ProtectSystem=full`, `PrivateTmp=true`,
`NoNewPrivileges=true`, and the remaining sandbox flags stay in force.

This is containment, not authentication: it limits what a compromised dashboard
process could write. It does not change the loopback-only listener or the M1
Host/origin checks.

### 2.8 Linger (optional, operator-controlled)

```bash
sudo loginctl enable-linger "$USER"    # host-level change; run only if you want it
```

Without linger, a systemd **user** service follows the user's login/session
lifecycle: it is normally stopped when your last session ends (e.g. after WSL
logoff). With linger enabled, the user's systemd manager keeps running after
logout/reboot, so the dashboard stays available. This is a host-level lifecycle
change and is **not** enabled by this repository or the install steps above.

## 3. Private remote access — Tailscale (recommended)

**Tailscale is a separate, manual step and is NOT installed or configured by
this repository.** Establish the loopback systemd service (section 2) first,
verify it locally, and only then add the private access layer.

Tailscale provides a private WireGuard mesh with device-level authentication and
identity. The dashboard never leaves loopback; only the tailnet can reach it.

**Free/personal tier:** Tailscale's Personal plan is free for a small number of
users/devices (check the current limits on your account before relying on it).

### 3.1 Install and join the tailnet (inside WSL)

```bash
curl -fsSL https://tailscale.com/install.sh | sh   # official installer
sudo tailscale up                                  # interactive login (browser)
tailscale status                                   # confirm the node is connected
```

`/dev/net/tun` is already present, so `tailscaled` can run normally.

### 3.2 Publish the dashboard to the tailnet ONLY

With the dashboard running on loopback:

```bash
sudo tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

This proxies `https://<machine>.<your-tailnet>.ts.net/` to the loopback
dashboard, reachable **only** by devices on your tailnet (Tailscale terminates
HTTPS and enforces tailnet identity).

> **Never use `tailscale funnel`.** `funnel` publishes to the public internet,
> which would expose the unauthenticated monitoring API. Only `tailscale serve`
> is appropriate here.

### 3.3 From the iPhone

1. Install the Tailscale app from the App Store and sign in to the **same**
   tailnet.
2. Open `https://<machine>.<your-tailnet>.ts.net/` in Safari.

Access is limited by tailnet membership. For tighter control, use Tailscale
**ACLs** to allow only specific devices (e.g. your phone) to reach this node.

### 3.4 Tailnet-only: keep the app bound to loopback

Do **not** set `DASHBOARD_HOST` / `DASHBOARD_ALLOW_REMOTE` for this setup. The
API stays on `127.0.0.1:8787`; Tailscale provides the private, authenticated
boundary.

Because every request must present an explicitly allowlisted `Host` header, you
must add the Tailscale Serve hostname to `DASHBOARD_ALLOWED_HOSTS` (the port is
parsed but ignored, and trailing/background hosts are not matched):

```bash
# .env
DASHBOARD_ALLOWED_HOSTS=127.0.0.1,localhost,::1,machine.tailnet.ts.net
```

A request whose `Host` hostname is not listed is rejected (421) **before** any
endpoint work; a cross-site (`Sec-Fetch-Site: cross-site`) or non-allowlisted
`Origin` request is rejected (403). `curl` and direct browser navigation keep
working because they send no cross-site browser metadata.

## 4. Alternative — SSH tunnel

Zero application changes; suitable for occasional access from a laptop:

```bash
ssh -N -L 8787:127.0.0.1:8787 brady@<host>
# then browse http://127.0.0.1:8787/
```

For an iPhone this needs an SSH client app and an active tunnel, so it is less
convenient for continuous monitoring than Tailscale. Keep the tunnel
authenticated (key-based SSH); do not add a public port-forward.

## 5. Considered and rejected

- **Cloudflare Access / Tunnel** — would work, but requires a Cloudflare
  account, a domain, `cloudflared` credentials/config on the host, and more
  moving parts than a personal dashboard warrants. Rejected as unnecessarily
  complex for this environment.
- **Direct LAN exposure** — WSL2 NAT means LAN devices cannot reach WSL
  directly; it would require a Windows `portproxy`, a firewall rule, and binding
  the unauthenticated API to a non-loopback address. Rejected: it weakens the
  security boundary for no benefit.

## 6. Network ports and listeners

| Listener | Scope | Notes |
| --- | --- | --- |
| `127.0.0.1:8787` (TCP) | WSL loopback only | API + static UI. Not reachable from LAN. |
| Tailscale (WireGuard) | Tailnet only | Outbound-initiated; no inbound public port required. |
| `tailscale serve` (TCP 443) | Tailnet only | Tailscale-terminated HTTPS to loopback. |

There is **no `0.0.0.0` listener**, no forwarded LAN port, and no public DNS
record. Do not add a Windows `netsh interface portproxy` rule for this service.

## 7. What is intentionally NOT exposed

- No public internet exposure; no `tailscale funnel`.
- No public/unauthenticated dashboard (tailnet device identity is the boundary).
- No application-level authentication or credentials (none are fabricated).
- No NDAX API credentials to the browser; no secrets in `web/` or
  `dist/dashboard/`.
- No state files, source files, `.env`, or arbitrary filesystem paths (the
  static server allowlists web-asset extensions and rejects dotfiles/traversal).
- No unlisted request hosts: `Host` must exactly match `DASHBOARD_ALLOWED_HOSTS`,
  and cross-site/foreign-`Origin` requests are rejected before any endpoint work
  (defense against DNS rebinding and cross-site endpoint triggering).
- No trading controls, order placement/cancellation, or reconciliation commits.

## 8. Rate limiting

The access boundary is a private, authenticated tailnet rather than a public
endpoint, so no custom application rate limiter is added. The UI itself never
polls `/api/reconciliation` and never overlaps reconciliation requests. If you
expose the dashboard more broadly (not recommended), add throttling at the
access layer, not in the trading code.

## 9. Secrets

- NDAX credentials remain server-side in `.env` and are never returned by the
  API or served as static assets.
- Access-layer identity (Tailscale) is managed by Tailscale, not by this repo.
- Do not add real credentials to this document or to any deployment file. The
  systemd unit intentionally contains no secrets and does not set
  `DASHBOARD_HOST`/`DASHBOARD_ALLOW_REMOTE`.

## 10. Failure behavior

- If the dashboard crashes, the unit restarts it (`Restart=on-failure`).
- If WSL is shut down (`wsl --shutdown`) or the machine sleeps, the dashboard and
  the tailnet node go away until WSL is running again.
- If Tailscale is down, remote access is unavailable but local
  `http://127.0.0.1:8787/` still works.
- The trading bot is unaffected: the dashboard is a separate process and never
  starts, stops, or mutates trading.

## 11. Manual steps still required (not automated here)

1. `npm run build` before first start.
2. Stop any already-running dashboard that owns `127.0.0.1:8787` (section 2.5).
3. Install the unit, `systemctl --user daemon-reload`, and verify with
   `systemd-analyze --user verify ...` (sections 2.2–2.3).
4. `systemctl --user enable ...` and `systemctl --user start ...` (section 2.4).
5. Optionally `sudo loginctl enable-linger "$USER"` for persistence after logout
   (section 2.8).
6. Install Tailscale and `sudo tailscale up` (interactive login) — separate,
   manual step; nothing here does it.
7. `sudo tailscale serve --bg http://127.0.0.1:8787`.
8. Install the Tailscale app on the iPhone and sign in to the same tailnet.
