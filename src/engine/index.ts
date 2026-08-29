/**
 * Engine module.
 *
 * `PaperEngine` wires market data, strategy, risk, paper execution, portfolio,
 * logging, and persistence into one continuously-running PAPER trading loop.
 * LIVE execution is deliberately absent at this phase.
 */

export { PaperEngine } from './PaperEngine.js';
export type { PaperEngineDeps, PaperEngineStatus } from './PaperEngine.js';
export { buildEngineDeps } from './buildEngine.js';
