import { describe, it, expect, afterEach } from 'vitest';
import {
  createMonitoringServer,
  isLoopbackHost,
  DEFAULT_MONITORING_HOST,
} from '../../../src/api/index.js';
import type { MonitoringReadModel, MonitoringServer } from '../../../src/api/index.js';

const servers: MonitoringServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {
      /* already closed */
    }
  }
});

function fakeModel(): MonitoringReadModel {
  return {
    async getSnapshot() {
      return {} as never;
    },
    async getHealth() {
      return {} as never;
    },
    async getReconciliation() {
      return {} as never;
    },
  };
}

describe('isLoopbackHost', () => {
  it('accepts loopback hosts only', () => {
    for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', 'LOCALHOST', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('rejects wildcard and network-reachable hosts', () => {
    for (const host of ['0.0.0.0', '::', '192.168.2.242', '10.0.0.5', 'example.com', '']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('MonitoringHttpServer — non-loopback bind guard', () => {
  it('defaults to loopback and never 0.0.0.0', () => {
    const server = createMonitoringServer({ monitoring: fakeModel() });
    expect(server.host).toBe('127.0.0.1');
    expect(DEFAULT_MONITORING_HOST).toBe('127.0.0.1');
  });

  it('refuses a non-loopback host unless explicitly opted in', () => {
    for (const host of ['0.0.0.0', '192.168.2.242', '::']) {
      expect(() => createMonitoringServer({ monitoring: fakeModel(), host }), host).toThrow(
        /non-loopback/i,
      );
    }
  });

  it('allows a non-loopback host only with the explicit opt-in', () => {
    const server = createMonitoringServer({
      monitoring: fakeModel(),
      host: '127.0.0.2', // still loopback, trivially safe to construct
      allowNonLoopback: false,
    });
    expect(server.host).toBe('127.0.0.2');

    // Explicit opt-in permits a non-loopback bind (constructed only; not bound).
    const opted = createMonitoringServer({
      monitoring: fakeModel(),
      host: '192.168.2.242',
      allowNonLoopback: true,
    });
    expect(opted.host).toBe('192.168.2.242');
  });

  it('still serves the API on loopback', async () => {
    const server = createMonitoringServer({ monitoring: fakeModel(), host: '127.0.0.1', port: 0 });
    servers.push(server);
    const address = await server.listen();
    const res = await fetch(`http://127.0.0.1:${address.port}/api/healthz`);
    expect(res.status).toBe(200);
  });
});
