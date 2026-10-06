/**
 * Dashboard entry point. Boots the read-only dashboard against the same-origin
 * monitoring API. No configuration, credentials, or origin are read here.
 */

import { Dashboard } from './app.js';

function boot(): void {
  const root = document.querySelector<HTMLElement>('[data-dashboard-root]');
  if (!root) return;
  const dashboard = new Dashboard(root);

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => dashboard.stop());
  }

  dashboard.start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
