/**
 * Read-only HTTP API module (Stage 2).
 *
 * A minimal `node:http` API over the Stage 1 monitoring read model. GET-only,
 * no auth, no CORS, loopback by default, no write routes. It does not import or
 * expose any execution/placement/cancellation/accounting functionality.
 */

export {
  createMonitoringServer,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_MONITORING_HOST,
  DEFAULT_MONITORING_PORT,
  evaluateRequestOrigin,
  isHostAllowed,
  isLoopbackHost,
} from './MonitoringHttpServer.js';
export type {
  MonitoringReadModel,
  MonitoringServer,
  MonitoringServerDeps,
  OriginDecision,
  RequestOriginHeaders,
} from './MonitoringHttpServer.js';
export { StaticAssets } from './staticFiles.js';
export type { StaticAsset } from './staticFiles.js';
