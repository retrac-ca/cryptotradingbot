import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const unitPath = `${repoRoot}deploy/systemd/cryptotradingbot-dashboard.service`;
const docsPath = `${repoRoot}docs/DASHBOARD_DEPLOYMENT.md`;

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('dashboard systemd user unit', () => {
  const unit = read(unitPath);

  it('exists', () => {
    expect(existsSync(unitPath)).toBe(true);
  });

  it('starts ONLY the dashboard command, never trading', () => {
    expect(unit).toMatch(/ExecStart=.*node.*dist\/index\.js dashboard/);
    for (const forbidden of [
      'bot start',
      'index.js paper',
      'live-test',
      'live-monitor',
      'manual',
      'resolve-live-order',
      'resolve-created-order',
      'backtest',
    ]) {
      expect(unit, forbidden).not.toContain(forbidden);
    }
  });

  it('keeps the listener on loopback (no public/LAN bind baked in)', () => {
    expect(unit).not.toContain('0.0.0.0');
    // It may *mention* these in comments, but must never SET them.
    expect(unit).not.toMatch(/DASHBOARD_HOST\s*=/);
    expect(unit).not.toMatch(/DASHBOARD_ALLOW_REMOTE\s*=/);
    expect(unit).toContain('WorkingDirectory=%h/code/cryptotradingbot');
  });

  it('performs only safe, no-secret hardening', () => {
    for (const required of [
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      'ProtectSystem=full',
      'ProtectKernelTunables=true',
      'ProtectKernelModules=true',
      'ProtectControlGroups=true',
      'RestrictSUIDSGID=true',
      'LockPersonality=true',
      'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
    ]) {
      expect(unit, required).toContain(required);
    }
    expect(unit).not.toMatch(/NDAX_API|API_SECRET|PASSWORD|TOKEN=/i);
  });

  it('M2: makes the home directory read-only with a single .state write exception', () => {
    expect(unit).toContain('ProtectHome=read-only');
    // Broad home access must never come back.
    expect(unit).not.toMatch(/ProtectHome\s*=\s*(no|yes|false|0)/i);

    const rwLines = unit
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('ReadWritePaths='));
    expect(rwLines.length).toBeGreaterThan(0);
    for (const line of rwLines) {
      // Every granted write path must be the repository state directory, e.g.
      // `ReadWritePaths=%h/code/cryptotradingbot/.state` or an absolute form.
      expect(line).toMatch(/[\\/]\.state\s*$/);
      expect(line).not.toMatch(/ReadWritePaths=\s*[\\/]?$/);
    }
  });

  it('runs as the login user (no separate service account required)', () => {
    // ProtectHome=read-only + a .state ReadWritePaths exception is sufficient;
    // a dedicated account would be a much larger architectural change.
    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toMatch(/^Group=/m);
  });
});

describe('dashboard deployment documentation', () => {
  const docs = read(docsPath);

  it('exists and covers required operational topics', () => {
    expect(existsSync(docsPath)).toBe(true);
    for (const topic of [
      'systemd',
      'systemd-analyze',
      'daemon-reload',
      'Tailscale',
      '127.0.0.1:8787',
      'enable-linger',
      'tailscale serve',
      'funnel',
      'SSH',
      'Cloudflare',
      'ProtectHome=read-only',
      'ReadWritePaths',
    ]) {
      expect(docs, topic).toContain(topic);
    }
  });

  it('documents stopping a stale process before starting the service', () => {
    expect(docs).toMatch(/stale|already[- ]running|already running/i);
  });

  it('warns against public exposure and documents that it is not configured', () => {
    expect(docs.toLowerCase()).toContain('never use `tailscale funnel`');
    expect(docs.toLowerCase()).toContain('rejected');
  });

  it('contains no real secret assignments', () => {
    const assignmentRe =
      /\b(?:NDAX_API_KEY|NDAX_API_SECRET|API_SECRET|PASSWORD|TOKEN)\s*=\s*\S+/i;
    expect(assignmentRe.test(docs)).toBe(false);
  });
});
