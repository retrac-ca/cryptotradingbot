/**
 * Gate 9.6 — constrained manual-execution CLI tests.
 *
 * The single most important property: running EVERY `bot manual` sub-command
 * against a fake exchange adapter must NEVER invoke an exchange write method
 * (`placeOrder`/`cancelOrder`, i.e. SendOrder/CancelOrder). Everything else
 * validates state semantics, fee fail-closed behavior, provenance wording,
 * reservation retention, and idempotency at the CLI surface.
 */

import { describe, expect, it } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { ManualIntentStore, ManualTradeBridge } from '../../../src/manual/index.js';
import { buildRiskManager } from '../../../src/risk/index.js';
import { botConfigSchema } from '../../../src/config/schema.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { toReadOnlyAdapter, runManualCommand, type ManualCliDeps } from '../../../src/cli/manual-cmd.js';
import { marketInfo, BTC, PRICE, NOW } from '../manual/helpers.js';
import { statePath } from '../../helpers/state.js';
import type { Order } from '../../../src/order.js';

function makeCfg() {
  return botConfigSchema.parse({});
}

function makeFake() {
  const fake = new FakeExchange();
  fake.setBalance('CAD', '100000');
  fake.setTicker(BTC, { bid: PRICE, ask: PRICE, last: PRICE, timestampMs: NOW });
  fake.setMarkets([marketInfo]);
  return fake;
}

interface Deps {
  deps: ManualCliDeps;
  fake: FakeExchange;
  intentFilePath: string;
  dispose: () => void;
}

function makeDeps(overrides?: { portfolio?: Portfolio; fake?: FakeExchange }): Deps {
  const fake = overrides?.fake ?? makeFake();
  const intentFilePath = statePath('g96', 'intents.json');
  let portfolio = overrides?.portfolio ?? Portfolio.empty(new Map([['CAD', Money.fromString('100000')]]));
  const cfg = makeCfg();
  const riskManager = buildRiskManager(cfg);
  const readOnly = toReadOnlyAdapter(fake);
  const bridge = new ManualTradeBridge({
    intentStore: new ManualIntentStore(intentFilePath),
    getPortfolio: () => portfolio,
    savePortfolio: (p) => { portfolio = p; },
    riskManager,
    adapter: readOnly,
    nowMs: () => NOW,
    operator: 'cli-test',
  });
  const deps: ManualCliDeps = {
    cfg,
    adapter: readOnly,
    bridge,
    getPortfolio: () => portfolio,
    riskManager,
    nowMs: () => NOW,
  };
  return {
    deps,
    fake,
    intentFilePath,
    dispose: () => {
      rmSync(intentFilePath, { force: true });
      rmSync(`${intentFilePath}.tmp`, { force: true });
    },
  };
}

async function proposeBuy(d: ManualCliDeps): Promise<{ code: number; json: Record<string, unknown>; intentId: string }> {
  const res = await runManualCommand(d, ['propose', '--symbol', BTC, '--side', 'BUY']);
  return { code: res.code, json: res.json, intentId: res.json.intentId as string };
}

describe('Gate 9.6 — manual CLI safety & workflow', () => {
  it('1+2: propose creates a durable PROPOSED intent and does NOT place an order', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    expect(p.code).toBe(0);
    expect(p.intentId).toMatch(/^manual-/);
    expect(p.json.state).toBe('PROPOSED');
    expect(p.json.provenanceProof).toBe(false);
    const intent = deps.bridge.get(p.intentId)!;
    expect(intent.status).toBe('PROPOSED');
    expect(intent.side).toBe('BUY');
    expect(deps.getPortfolio().orderReservation(p.intentId)!.status).toBe('ACTIVE');
    expect(fake.submittedOrders.length).toBe(0);
    dispose();
  });

  it('3: confirm does NOT place an exchange order and does not imply execution', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    const c = await runManualCommand(deps, ['confirm', p.intentId]);
    expect(c.code).toBe(0);
    expect(c.json.state).toBe('CONFIRMED');
    const intent = deps.bridge.get(p.intentId)!;
    expect(intent.status).toBe('CONFIRMED');
    expect(intent.evidence).toBeNull(); // confirm is NOT execution/evidence
    expect(fake.submittedOrders.length).toBe(0);
    dispose();
  });

  it('4: instructions explicitly state external/manual execution and RETRAC never places', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    const ins = await runManualCommand(deps, ['instructions', p.intentId]);
    expect(ins.code).toBe(0);
    expect(ins.lines.join('\n')).toMatch(/RETRAC will NOT place this order/i);
    expect(ins.lines.join('\n')).toMatch(/PRESERVE the exchange OrderId/i);
    expect(ins.lines.join('\n')).toMatch(/NOT proof of intent provenance/i);
    expect(fake.submittedOrders.length).toBe(0);
    dispose();
  });

  it('5: an externally supplied OrderId can be recorded as evidence', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    await runManualCommand(deps, ['confirm', p.intentId]);
    const intent = deps.bridge.get(p.intentId)!;
    const ev = await runManualCommand(deps, ['evidence', p.intentId, '--order-id', '999001', '--status', 'FILLED', '--filled-qty', intent.quantity.toString(), '--avg-price', PRICE.toString()]);
    expect(ev.code).toBe(0);
    expect(ev.json.orderId).toBe('999001');
    expect(ev.json.state).toBe('EVIDENCE_RECORDED');
    expect(deps.bridge.get(p.intentId)!.evidence?.orderId).toBe('999001');
    expect(fake.submittedOrders.length).toBe(0);
    dispose();
  });

  it('6: an unrelated OrderId (no binding) fails closed in verify', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    await runManualCommand(deps, ['confirm', p.intentId]);
    const intent = deps.bridge.get(p.intentId)!;
    await runManualCommand(deps, ['evidence', p.intentId, '--order-id', '999001', '--status', 'FILLED', '--filled-qty', intent.quantity.toString(), '--avg-price', PRICE.toString()]);
    // Seed a same-symbol/same-side order with a WRONG requested quantity => unrelated.
    fake.seedOrders([exchangeOrderFor(intent, { quantity: Money.fromString('0.999'), filledQuantity: intent.quantity })]);
    const v = await runManualCommand(deps, ['verify', p.intentId]);
    expect(v.code).toBe(2);
    expect(v.json.provenance).toBe('NOT PROVEN');
    expect((v.json.exchangeValidation as Record<string, unknown>).status).toBe('INCONSISTENT');
    dispose();
  });

  it('7+8: verify is read-only and cannot call placeOrder/cancelOrder', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    await runManualCommand(deps, ['confirm', p.intentId]);
    const intent = deps.bridge.get(p.intentId)!;
    await runManualCommand(deps, ['evidence', p.intentId, '--order-id', '999001', '--status', 'FILLED', '--filled-qty', intent.quantity.toString(), '--avg-price', PRICE.toString()]);
    fake.seedOrders([exchangeOrderFor(intent, { quantity: intent.quantity })]);
    const v = await runManualCommand(deps, ['verify', p.intentId]);
    expect(v.code).toBe(0); // consistent
    expect(v.json.provenance).toBe('NOT PROVEN');
    const ctl = (v.json.exchangeValidation as Record<string, unknown>);
    expect(ctl.status).toBe('CONSISTENT');
    expect(ctl.provenanceProof).toBe(false);
    expect(fake.submittedOrders.length).toBe(0);
    // The read-only proxy structurally blocks writes.
    await expect((deps.adapter as unknown as { placeOrder(): Promise<unknown> }).placeOrder({ symbol: BTC, side: 'BUY', type: 'market', quantity: Money.fromString('0.01'), clientOrderId: 'x', reason: 'x' })).rejects.toThrow(/write methods are disabled/);
    dispose();
  });

  it('9+10+15: unknown and base non-zero fee lead to RECONCILIATION_REQUIRED (never accounting success; fee never becomes quote)', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    await runManualCommand(deps, ['confirm', p.intentId]);
    const intent = deps.bridge.get(p.intentId)!;
    await runManualCommand(deps, ['evidence', p.intentId, '--order-id', '999001', '--status', 'FILLED', '--filled-qty', intent.quantity.toString(), '--avg-price', PRICE.toString()]);
    // Real NDAX order-status shape: nonzero fee, currency unknown.
    fake.seedOrders([exchangeOrderFor(intent, { quantity: intent.quantity, fee: Money.fromString('10.00'), feeCurrency: 'unknown' })]);
    const s = await runManualCommand(deps, ['settle', p.intentId, '--confirm']);
    expect(s.code).toBe(2);
    expect(s.json.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(deps.bridge.get(p.intentId)!.status).toBe('RECONCILIATION_REQUIRED');
    expect(deps.getPortfolio().orderReservation(p.intentId)!.status).toBe('ACTIVE'); // retained
    expect(deps.getPortfolio().manualSettlement(p.intentId)).toBeNull(); // no accounting
    // A base fee is never reinterpreted as quote.
    fake.seedOrders([exchangeOrderFor(intent, { quantity: intent.quantity, fee: Money.fromString('10.00'), feeCurrency: 'base' })]);
    const s2 = await runManualCommand(deps, ['settle', p.intentId, '--confirm']);
    expect(s2.code).toBe(2);
    expect(s2.json.outcome).toBe('RECONCILIATION_REQUIRED');
    dispose();
  });

  it('11+13: exchange-validated accounting enters ACCOUNTED_WITH_EXCHANGE_VALIDATION (provenanceProof=false)', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    await runManualCommand(deps, ['confirm', p.intentId]);
    const intent = deps.bridge.get(p.intentId)!;
    await runManualCommand(deps, ['evidence', p.intentId, '--order-id', '999001', '--status', 'FILLED', '--filled-qty', intent.quantity.toString(), '--avg-price', PRICE.toString()]);
    fake.seedOrders([exchangeOrderFor(intent, { quantity: intent.quantity, fee: Money.fromString('10.00'), feeCurrency: 'quote' })]);
    const s = await runManualCommand(deps, ['settle', p.intentId, '--confirm', '--accounting-authority', 'exchange']);
    expect(s.code).toBe(0);
    expect(s.json.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    expect(s.json.provenanceProof).toBe(false);
    expect(s.json.settlementMode).toBe('exchange_validated');
    expect(s.json.exchangeValidated).toBe(true);
    expect(deps.getPortfolio().orderReservation(p.intentId)!.status).toBe('RELEASED');
    dispose();
  });

  it('12+13: operator-attested accounting enters ACCOUNTED_WITH_OPERATOR_ATTESTATION (provenanceProof=false)', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    await runManualCommand(deps, ['confirm', p.intentId]);
    const intent = deps.bridge.get(p.intentId)!;
    await runManualCommand(deps, ['evidence', p.intentId, '--order-id', '999001', '--status', 'FILLED', '--filled-qty', intent.quantity.toString(), '--avg-price', PRICE.toString()]);
    fake.seedOrders([exchangeOrderFor(intent, { quantity: intent.quantity, fee: Money.fromString('10.00'), feeCurrency: 'quote' })]);
    const s = await runManualCommand(deps, ['settle', p.intentId, '--confirm', '--accounting-authority', 'operator_attestation']);
    expect(s.code).toBe(0);
    expect(s.json.outcome).toBe('ACCOUNTED_WITH_OPERATOR_ATTESTATION');
    expect(s.json.provenanceProof).toBe(false);
    expect(s.json.settlementMode).toBe('operator_attested');
    expect(s.json.accountingAuthority).toBe('operator_attestation');
    dispose();
  });

  it('14+J: AMBIGUOUS remains blocked and retains reservation', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    await runManualCommand(deps, ['confirm', p.intentId]);
    const intent = deps.bridge.get(p.intentId)!;
    await runManualCommand(deps, ['evidence', p.intentId, '--order-id', '999001', '--status', 'FILLED', '--filled-qty', Money.fromString('0.01').toString(), '--avg-price', PRICE.toString()]);
    // The authoritative order says a DIFFERENT fill => contradiction.
    fake.seedOrders([exchangeOrderFor(intent, { quantity: intent.quantity, filledQuantity: intent.quantity, fee: Money.fromString('10.00'), feeCurrency: 'quote' })]);
    const s = await runManualCommand(deps, ['settle', p.intentId, '--confirm']);
    expect(s.code).toBe(2);
    expect(s.json.outcome).toBe('AMBIGUOUS');
    expect(deps.getPortfolio().orderReservation(p.intentId)!.status).toBe('ACTIVE');
    dispose();
  });

  it('16+17: zero-fill terminal release happens once via settle; reservation retained on unresolved positive', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    await runManualCommand(deps, ['confirm', p.intentId]);
    const intent = deps.bridge.get(p.intentId)!;
    await runManualCommand(deps, ['evidence', p.intentId, '--order-id', '999001', '--status', 'CANCELED', '--filled-qty', Money.zero().toString(), '--avg-price', PRICE.toString()]);
    fake.seedOrders([exchangeOrderFor(intent, { quantity: intent.quantity, filledQuantity: Money.zero(), averagePrice: null, fee: Money.fromString('40.00'), feeCurrency: 'quote', status: 'CANCELED' })]);
    const s = await runManualCommand(deps, ['settle', p.intentId, '--confirm']);
    expect(s.code).toBe(0);
    expect(s.json.outcome).toBe('CANCELED_TERMINAL_NO_FILL');
    expect(deps.getPortfolio().orderReservation(p.intentId)!.status).toBe('RELEASED');
    expect(deps.getPortfolio().reserved('CAD').isZero()).toBe(true);
    dispose();
  });

  it('21: restart preserves intent state and settlement mode', async () => {
    const { deps, fake, dispose, intentFilePath } = makeDeps();
    const p = await proposeBuy(deps);
    await runManualCommand(deps, ['confirm', p.intentId]);
    const intent = deps.bridge.get(p.intentId)!;
    await runManualCommand(deps, ['evidence', p.intentId, '--order-id', '999001', '--status', 'FILLED', '--filled-qty', intent.quantity.toString(), '--avg-price', PRICE.toString()]);
    fake.seedOrders([exchangeOrderFor(intent, { quantity: intent.quantity, fee: Money.fromString('10.00'), feeCurrency: 'quote' })]);
    await runManualCommand(deps, ['settle', p.intentId, '--confirm']);
    expect(deps.bridge.get(p.intentId)!.status).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    // Reload the intent store from disk (simulate restart).
    const reloaded = new ManualIntentStore(intentFilePath);
    expect(reloaded.get(p.intentId)!.status).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    const s = deps.getPortfolio().manualSettlement(p.intentId)!;
    expect(s.settlementMode).toBe('exchange_validated');
    expect(s.provenanceProof).toBe(false);
    dispose();
  });

  it('22+25: cancel-intent never invokes exchange cancellation and only cancels the local intent', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    const c = await runManualCommand(deps, ['cancel-intent', p.intentId, '--confirm', '--reason', 'abort']);
    expect(c.code).toBe(0);
    expect(c.json.state).toBe('CANCELED');
    expect(deps.bridge.get(p.intentId)!.status).toBe('CANCELED');
    expect(deps.getPortfolio().orderReservation(p.intentId)!.status).toBe('RELEASED');
    expect(fake.submittedOrders.length).toBe(0);
    // No exchange cancel was ever requested (the adapter only has getOrderStatus).
    dispose();
  });

  it('18: duplicate settlement is idempotent at the CLI surface (REFUSED, no re-account)', async () => {
    const { deps, fake, dispose } = makeDeps();
    const p = await proposeBuy(deps);
    await runManualCommand(deps, ['confirm', p.intentId]);
    const intent = deps.bridge.get(p.intentId)!;
    await runManualCommand(deps, ['evidence', p.intentId, '--order-id', '999001', '--status', 'FILLED', '--filled-qty', intent.quantity.toString(), '--avg-price', PRICE.toString()]);
    fake.seedOrders([exchangeOrderFor(intent, { quantity: intent.quantity, fee: Money.fromString('10.00'), feeCurrency: 'quote' })]);
    const first = await runManualCommand(deps, ['settle', p.intentId, '--confirm']);
    expect(first.code).toBe(0);
    const cash = deps.getPortfolio().cash('CAD').toString();
    const second = await runManualCommand(deps, ['settle', p.intentId, '--confirm']);
    expect(second.code).toBe(1); // REFUSED (terminal state)
    expect(deps.getPortfolio().cash('CAD').toString()).toBe(cash);
    dispose();
  });

  it('20: a corrupt intent store fails closed', async () => {
    const { deps, dispose, intentFilePath } = makeDeps();
    rmSync(intentFilePath, { force: true });
    writeFileSync(intentFilePath, '{ invalid');
    const list = await runManualCommand(deps, ['list']);
    // Corrupt store => the bridge throws on read (allIntents) => reconcile/list fail closed.
    const r = await runManualCommand(deps, ['reconcile']);
    expect(r.code).toBe(2);
    expect((r.json.issues as unknown[]).map((i) => (i as Record<string, unknown>).type)).toContain('CORRUPT_INTENT_STORE');
    expect(list.code).toBeGreaterThan(0);
    dispose();
  });

  it('26: the CLI can display reservations and list intents, both read-only', async () => {
    const { deps, fake, dispose } = makeDeps();
    await proposeBuy(deps);
    const res = await runManualCommand(deps, ['reservations']);
    expect(res.code).toBe(0);
    expect((res.json.reservations as unknown[]).length).toBe(1);
    const list = await runManualCommand(deps, ['list']);
    expect(list.code).toBe(0);
    expect((list.json.intents as unknown[]).length).toBe(1);
    expect(fake.submittedOrders.length).toBe(0);
    dispose();
  });

  it('25 (global): running every manual command NEVER reaches an exchange write method', async () => {
    const { deps, fake, dispose } = makeDeps();
    let placeCalls = 0;
    let cancelCalls = 0;
    const origPlace = FakeExchange.prototype.placeOrder;
    const origCancel = FakeExchange.prototype.cancelOrder;
    FakeExchange.prototype.placeOrder = function () { placeCalls += 1; throw new Error('must never place'); };
    FakeExchange.prototype.cancelOrder = function () { cancelCalls += 1; throw new Error('must never cancel'); };
    try {
      const p = await proposeBuy(deps);
      await runManualCommand(deps, ['confirm', p.intentId]);
      await runManualCommand(deps, ['instructions', p.intentId]);
      const intent = deps.bridge.get(p.intentId)!;
      await runManualCommand(deps, ['evidence', p.intentId, '--order-id', '999001', '--status', 'FILLED', '--filled-qty', intent.quantity.toString(), '--avg-price', PRICE.toString()]);
      fake.seedOrders([exchangeOrderFor(intent, { quantity: intent.quantity, fee: Money.fromString('10.00'), feeCurrency: 'quote' })]);
      await runManualCommand(deps, ['verify', p.intentId]);
      await runManualCommand(deps, ['settle', p.intentId, '--confirm']);
      await runManualCommand(deps, ['reconcile']);
      await runManualCommand(deps, ['show', p.intentId]);
      await runManualCommand(deps, ['list']);
      await runManualCommand(deps, ['reservations']);
      expect(placeCalls).toBe(0);
      expect(cancelCalls).toBe(0);
      expect(fake.submittedOrders.length).toBe(0);
    } finally {
      FakeExchange.prototype.placeOrder = origPlace;
      FakeExchange.prototype.cancelOrder = origCancel;
      dispose();
    }
  });
});

// Build a canonical exchange order that binds to the intent (requested qty matches).
function exchangeOrderFor(intent: ReturnType<ManualTradeBridge['get']>, over: Partial<Order> = {}): Order {
  return {
    clientOrderId: '',
    symbol: BTC,
    side: 'BUY',
    type: 'market',
    status: 'FILLED',
    quantity: intent.quantity,
    filledQuantity: intent.quantity,
    averagePrice: PRICE,
    price: null,
    fills: [],
    fee: Money.fromString('40.00'),
    feeCurrency: 'quote',
    reason: '',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    exchangeOrderId: '999001',
    ...over,
  };
}
