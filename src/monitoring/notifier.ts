/**
 * Notifier — optional, best-effort outbound alerting for critical engine events.
 *
 * Two independent transports, both optional:
 *   - a generic JSON webhook (POST { source, kind, detail, atMs }),
 *   - an ntfy topic (POST the detail text to `<server>/<topic>`).
 *
 * Safety properties:
 *   - Fully FAIL-OPEN for the engine: `notify` is fire-and-forget and NEVER
 *     throws; a delivery failure is logged and dropped.
 *   - Debounced per (kind, detail) by `minIntervalMs` so a persistent condition
 *     cannot create an alert storm.
 *   - No secret is ever placed in alert text. The webhook URL itself may embed a
 *     secret token; it is never logged.
 */

import type { Logger } from '../logging/logger.js';

export interface Alert {
  kind: string;
  detail: string;
  atMs: number;
}

export interface Notifier {
  notify(alert: Alert): void;
}

export interface NotifierOptions {
  webhookUrl?: string;
  ntfyTopic?: string;
  ntfyServer?: string;
  minIntervalMs?: number;
  source?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/** A no-op notifier used when nothing is configured. */
export const NULL_NOTIFIER: Notifier = { notify: () => {} };

export function createNotifier(opts: NotifierOptions): Notifier {
  const webhookUrl = opts.webhookUrl?.trim() ?? '';
  const ntfyTopic = opts.ntfyTopic?.trim() ?? '';
  const ntfyServer = (opts.ntfyServer?.trim() || 'https://ntfy.sh').replace(/\/+$/, '');
  const minIntervalMs = opts.minIntervalMs ?? 60_000;
  const source = opts.source ?? 'cryptotradingbot';
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const lastSent = new Map<string, number>();

  if (!webhookUrl && !ntfyTopic) return NULL_NOTIFIER;

  const send = async (alert: Alert): Promise<void> => {
    const body = { source, kind: alert.kind, detail: alert.detail, atMs: alert.atMs };
    const tasks: Promise<unknown>[] = [];
    if (webhookUrl && doFetch) {
      tasks.push(
        doFetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    }
    if (ntfyTopic && doFetch) {
      tasks.push(
        doFetch(`${ntfyServer}/${encodeURIComponent(ntfyTopic)}`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain', Title: `cryptotradingbot: ${alert.kind}` },
          body: `${alert.kind}: ${alert.detail}`,
        }),
      );
    }
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'rejected') {
        opts.logger?.warn({ err: r.reason }, 'alert delivery failed');
      }
    }
  };

  return {
    notify(alert: Alert): void {
      const key = `${alert.kind}|${alert.detail}`;
      const now = alert.atMs || Date.now();
      const prev = lastSent.get(key);
      if (prev !== undefined && now - prev < minIntervalMs) return;
      lastSent.set(key, now);
      // Fire-and-forget; never block or throw into the engine.
      void send(alert).catch((err) => {
        opts.logger?.warn({ err }, 'alert send threw');
      });
    },
  };
}
