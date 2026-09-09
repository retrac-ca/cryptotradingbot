/**
 * `bot resolve-live-order` — operator-attested resolution CLI tests.
 *
 * The most important properties: the command NEVER invokes an exchange write
 * method (`placeOrder`/`cancelOrder`, i.e. SendOrder/CancelOrder), requires
 * explicit operator confirmation + identity + accounting authority, fails closed
 * on fresh-read failures and TOCTOU evidence/order changes, and does not adopt
 * the residual exchange balance as order proceeds.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { OrderStore, ManagedStateStore } from '../../../src/persistence/index.js';
import { ManualIntentStore } from '../../../src/manual/index.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { ResourceNotFoundError } from '../../../src/exchanges/errors.js';
import type { AccountTrade } from '../../../src/types.js';
import { toReadOnlyAdapter } from '../../../src/cli/manual-cmd.js';
import { runResolveLiveOrder, type ResolveLiveOrderDeps } from '../../../src/cli/resolve-live-order-cmd.js';
import { reconcile, type ReconciliationDeps } from '../../../src/reconcile/index.js';
import { statePath } from '../../helpers/state.js';
import type { Order } from '../../../src/order.js';

const CLIENT = 'live-BTCCAD-287fdb4f-c1cf-486c-a049-cac2dbd4da44';
const EXCHANGE_ORDER = '26177556994';
const SYMBOL = 'BTC/CAD';
const QTY = Money.fromString('0.00011059');
const PRICE = Money.fromString('108500.00');
const POSITION_BEFORE = Money.fromString('0.00034411');
const POSITION_AFTER = Money.fromString('0.00023352');
const NOW = 1_000_000_000;

function externalBtcPosition(): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString('0')]]))
    .withExternalSnapshot(new Map([[SYMBOL, POSITION_BEFORE]]))
    .authorizeExternal(SYMBOL);
}

function localOrder(over: Partial<Order> = {}): Order {
  return {
    clientOrderId: CLIENT,
    exchangeOrderId: EXCHANGE_ORDER,
    symbol: SYMBOL,
    side: 'SELL',
    type: 'limit',
    status: 'SUBMITTED',
    quantity: QTY,
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: PRICE,
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'unknown',
    reason: 'live-test SELL (target 12 CAD)',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  };
}

function exchangeFilled(over: Partial<Order> = {}): Order {
  return {
    clientOrderId: '',
    exchangeOrderId: EXCHANGE_ORDER,
    symbol: SYMBOL,
    side: 'SELL',
    type: 'limit',
    status: 'FILLED',
    quantity: QTY,
    filledQuantity: QTY,
    averagePrice: PRICE,
    price: PRICE,
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'unknown',
    reason: 'live-test SELL (target 12 CAD)',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  };
}

function makeFakeWithOrder(over: Partial<Order>): FakeExchange {
  const f = new FakeExchange();
  f.seedOrders([exchangeFilled(over)]);
  f.setBalance('BTC', POSITION_AFTER.toString());
  f.setBalance('CAD', '37.99775272');
  return f;
}

/** A fake whose per-order GetOrderStatus throws ResourceNotFoundError (history-only order). */
class NotFoundHistoryFake extends FakeExchange {
  constructor(historyOrders: Order[]) {
    super();
    this.seedOrders(historyOrders);
    this.setBalance('BTC', POSITION_AFTER.toString());
    this.setBalance('CAD', '37.99775272');
  }

  async getOrderStatus(_symbol: string, _clientOrderId?: string, _exchangeOrderId?: string): Promise<Order> {
    throw new ResourceNotFoundError('NDAX order not found');
  }
}

/** A fake with a correlated AccountTrade and an optional fee-currency resolver. */
function makeFeeFake(opts: {
  feeKind?: 'quote' | 'base' | 'other' | 'unknown';
  withResolver?: boolean;
  trades?: AccountTrade[];
}): FakeExchange {
  const f = new FakeExchange();
  f.seedOrders([exchangeFilled()]);
  f.seedAccountTrades(opts.trades ?? [correlatedTrade('0.02399803')]);
  f.setBalance('BTC', POSITION_AFTER.toString());
  f.setBalance('CAD', '37.99775272');
  if (opts.withResolver ?? true) {
    const kind = opts.feeKind ?? 'quote';
    (f as FakeExchange & { resolveFeeCurrency?: (p: string | null | undefined, s: string) => Promise<unknown> }).resolveFeeCurrency = async (feeProductId) => ({
      kind: kind === 'quote' ? 'quote' : kind === 'base' ? 'base' : kind === 'other' ? 'other' : 'unknown',
      currency: kind === 'quote' ? 'quote' : 'unknown',
      assetSymbol: kind === 'quote' ? 'CAD' : null,
      feeProductId: feeProductId ?? null,
    });
  }
  return f;
}

/** Build an exact AccountTrade correlated to the live order. */
function correlatedTrade(fee: string, over: Partial<AccountTrade> = {}): AccountTrade {
  return {
    executionId: '25437609',
    tradeId: '15084496',
    orderId: EXCHANGE_ORDER,
    clientOrderId: '0',
    symbol: SYMBOL,
    instrumentId: '1',
    accountId: '1',
    subAccountId: '0',
    side: 'SELL',
    quantity: QTY,
    remainingQuantity: Money.zero(),
    price: PRICE,
    value: QTY.mul(PRICE),
    tradeTimeMs: NOW,
    fee: Money.fromString(fee),
    feeProductId: '7',
    orderOriginator: null,
    ...over,
  };
}

interface Deps {
  deps: ResolveLiveOrderDeps;
  fake: FakeExchange;
  orders: OrderStore;
  live: ManagedStateStore;
  stateDir: string;
  dispose: () => void;
}

function makeDeps(overrides?: {
  fake?: FakeExchange;
  confirm?: (m: string) => Promise<boolean>;
  liveOrder?: Order;
}): Deps {
  const stateDir = statePath('rlo', 'dir');
  const orders = new OrderStore(`${stateDir}/ledger.json`);
  const live = new ManagedStateStore(`${stateDir}/live.json`);
  const fake = overrides?.fake ?? new FakeExchange();
  orders.save(overrides?.liveOrder ?? localOrder());
  live.save(externalBtcPosition().stateModel);
  // Only seed the default exchange state when the caller did NOT supply a custom
  // fake (a custom fake is assumed to pre-seed its own authoritative state).
  if (!overrides?.fake) {
    fake.seedOrders([exchangeFilled()]);
    fake.seedAccountTrades([]);
    fake.setBalance('BTC', POSITION_AFTER.toString());
    fake.setBalance('CAD', '37.99775272');
  }
  const readOnly = toReadOnlyAdapter(fake);
  const deps: ResolveLiveOrderDeps = {
    cfg: { stateDir },
    adapter: readOnly,
    orders,
    live,
    nowMs: () => NOW,
    confirm: overrides?.confirm,
  };
  return { deps, fake, orders, live, stateDir, dispose: () => undefined };
}

const BASE_ARGS = [
  CLIENT,
  '--order-id', EXCHANGE_ORDER,
  '--operator', 'operator-alice',
  '--accounting-authority', 'operator_attestation',
  '--confirm',
];

describe('bot resolve-live-order — operator-attested resolution CLI', () => {
  it('resolves the real ambiguous FILLED live order (zero fee) without an exchange mutation', async () => {
    const { deps, fake, live, dispose } = makeDeps();
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    expect(res.json.outcome).toBe('ATTESTED');
    expect(res.json.status).toBe('FILLED');
    expect(res.json.filledQuantity).toBe(QTY.toString());
    expect(res.json.provenanceProof).toBe(false);
    expect(res.json.accountingAuthority).toBe('operator_attestation');
    // No exchange order was submitted/canceled (read-only proxy would throw).
    expect(fake.submittedOrders.length).toBe(0);
    // The EXTERNAL_AUTHORIZED position reduced exactly; no BOT inventory.
    const pf = live.toPortfolio(live.load().data!)!;
    expect(pf.position(SYMBOL)!.quantity.toString()).toBe(POSITION_AFTER.toString());
    expect(pf.position(SYMBOL)!.sourceQuantities.EXTERNAL_AUTHORIZED.toString()).toBe(POSITION_AFTER.toString());
    expect(pf.position(SYMBOL)!.sourceQuantities.BOT.toString()).toBe('0.00000000');
    expect(pf.liveOrderAttestation(CLIENT)).not.toBeNull();
    // Only attributable proceeds booked; residual CAD (37.99) NOT adopted.
    expect(pf.cash('CAD').toString()).toBe(QTY.mul(PRICE).toString());
    expect(pf.cash('CAD').compareTo(Money.fromString('37.99775272'))).toBeLessThan(0);
    dispose();
  });

  it('records an authoritative quote fee when the exchange fee currency is quote', async () => {
    const { deps, live, dispose } = makeDeps({ fake: (() => {
      const f = new FakeExchange();
      f.seedOrders([exchangeFilled({ fee: Money.fromString('0.02'), feeCurrency: 'quote' })]);
      f.setBalance('BTC', POSITION_AFTER.toString());
      f.setBalance('CAD', '37.99775272');
      return f;
    })() });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    const pf = live.toPortfolio(live.load().data!)!;
    expect(pf.cash('CAD').toString()).toBe(QTY.mul(PRICE).sub(Money.fromString('0.02')).toString());
    expect(pf.liveOrderAttestation(CLIENT)!.fee.toString()).toBe('0.02000000');
    dispose();
  });

  it('18: reconciliation recognizes the attested order as resolved', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    const recDeps: ReconciliationDeps = {
      stateDir: deps.cfg.stateDir,
      orders: deps.orders,
      live: deps.live,
      manualIntents: new ManualIntentStore(`${deps.cfg.stateDir}/intents.json`),
      adapter: deps.adapter,
    };
    const report = await reconcile(recDeps);
    const finding = report.orderFindings.find((o) => o.clientOrderId === CLIENT)!;
    expect(finding.disposition).toBe('CONFIRMED'); // not OPERATOR_REQUIRED
    expect(finding.completeness).toBe('COMPLETE'); // operator-attested
    // The unrelated CAD residual remains a separate (non-auto-adopted) discrepancy.
    expect(report.balanceFindings.some((b) => b.currency === 'CAD' && b.mismatch)).toBe(true);
    dispose();
  });

  it('20: a TOCTOU order change aborts before mutation', async () => {
    const { deps, orders, live, dispose } = makeDeps({
      confirm: async () => {
        // Simulate a concurrent actor mutating the order ledger mid-flow.
        orders.save(localOrder({ exchangeOrderId: '999999' }));
        return true;
      },
    });
    const res = await runResolveLiveOrder(deps, BASE_ARGS.filter((a) => a !== '--confirm'));
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('attestation_aborted');
    expect(live.toPortfolio(live.load().data!)!.position(SYMBOL)!.quantity.toString()).toBe(POSITION_BEFORE.toString());
    expect(live.toPortfolio(live.load().data!)!.liveOrderAttestation(CLIENT)).toBeNull();
    dispose();
  });

  it('21: a TOCTOU exchange-evidence mismatch aborts before mutation', async () => {
    const { deps, fake, live, dispose } = makeDeps({
      confirm: async () => {
        // Simulate the exchange state changing after the pre-confirmation read.
        fake.seedOrders([exchangeFilled({ status: 'CANCELED' })]);
        return true;
      },
    });
    const res = await runResolveLiveOrder(deps, BASE_ARGS.filter((a) => a !== '--confirm'));
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('not_filled');
    expect(live.toPortfolio(live.load().data!)!.position(SYMBOL)!.quantity.toString()).toBe(POSITION_BEFORE.toString());
    dispose();
  });

  it('25: no exchange mutation method is invoked (read-only proxy)', async () => {
    const { deps, fake, dispose } = makeDeps();
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    expect(fake.submittedOrders.length).toBe(0);
    dispose();
  });

  it('26: confirmation is required (no accounting without it)', async () => {
    const { deps, live, dispose } = makeDeps({ confirm: async () => false });
    const res = await runResolveLiveOrder(deps, BASE_ARGS.filter((a) => a !== '--confirm'));
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('not_confirmed');
    expect(live.toPortfolio(live.load().data!)!.position(SYMBOL)!.quantity.toString()).toBe(POSITION_BEFORE.toString());
    dispose();
  });

  it('27: operator identity is required', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveLiveOrder(deps, BASE_ARGS.filter((a) => a !== '--operator' && a !== 'operator-alice'));
    expect(res.code).toBe(1);
    expect(res.json.error).toMatch(/--operator is required/);
    dispose();
  });

  it('28: accounting authority must be explicitly operator_attestation', async () => {
    const { deps, dispose } = makeDeps();
    const bad = await runResolveLiveOrder(deps, BASE_ARGS.filter((a) => a !== '--accounting-authority' && a !== 'operator_attestation'));
    expect(bad.code).toBe(1);
    expect(bad.json.error).toMatch(/accounting-authority/);
    const wrong = await runResolveLiveOrder(deps, BASE_ARGS.map((a) => (a === 'operator_attestation' ? 'exchange' : a)));
    expect(wrong.code).toBe(1);
    expect(wrong.json.error).toMatch(/accounting-authority/);
    dispose();
  });

  it('29: a failed fresh exchange read fails closed', async () => {
    const { deps, live, dispose } = makeDeps({ fake: (() => {
      const f = new FakeExchange();
      f.seedOrders([exchangeFilled()]);
      f.setBalance('BTC', POSITION_AFTER.toString());
      f.setBalance('CAD', '37.99775272');
      f.setFailures({ getOrderStatus: { kind: 'network' } });
      return f;
    })() });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_read_failed');
    expect(live.toPortfolio(live.load().data!)!.position(SYMBOL)!.quantity.toString()).toBe(POSITION_BEFORE.toString());
    dispose();
  });

  it('an unknown non-zero fee fails closed (order is not resolved)', async () => {
    const { deps, live, dispose } = makeDeps({ fake: (() => {
      const f = new FakeExchange();
      f.seedOrders([exchangeFilled({ fee: Money.fromString('0.02'), feeCurrency: 'unknown' })]);
      f.setBalance('BTC', POSITION_AFTER.toString());
      f.setBalance('CAD', '37.99775272');
      return f;
    })() });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('fee_unresolved');
    expect(live.toPortfolio(live.load().data!)!.position(SYMBOL)!.quantity.toString()).toBe(POSITION_BEFORE.toString());
    expect(live.toPortfolio(live.load().data!)!.liveOrderAttestation(CLIENT)).toBeNull();
    dispose();
  });

  it('a wrong exchange OrderId is rejected (must match the persisted live order)', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveLiveOrder(deps, BASE_ARGS.map((a) => (a === EXCHANGE_ORDER ? '999999' : a)));
    expect(res.code).toBe(1);
    expect(res.json.error).toBe('order_id_mismatch');
    dispose();
  });

  it('a local order already FILLED by the monitor (no attestation) can be resolved', async () => {
    const { deps, live, dispose } = makeDeps({ liveOrder: localOrder({ status: 'FILLED' }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    const pf = live.toPortfolio(live.load().data!)!;
    expect(pf.position(SYMBOL)!.quantity.toString()).toBe(POSITION_AFTER.toString());
    expect(pf.liveOrderAttestation(CLIENT)).not.toBeNull();
    expect(pf.liveOrderAttestation(CLIENT)!.attestationId).toBe(`op-attest:${CLIENT}`);
    dispose();
  });

  it('an identical repeat after a successful attestation is idempotent (no double accounting)', async () => {
    const { deps, live, dispose } = makeDeps();
    const first = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(first.code).toBe(0);
    const pf1 = live.toPortfolio(live.load().data!)!;
    const qtyAfter = pf1.position(SYMBOL)!.quantity.toString();
    const cashAfter = pf1.cash('CAD').toString();
    const second = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(second.code).toBe(0);
    const pf2 = live.toPortfolio(live.load().data!)!;
    expect(pf2.position(SYMBOL)!.quantity.toString()).toBe(qtyAfter); // not reduced again
    expect(pf2.cash('CAD').toString()).toBe(cashAfter); // not re-credited
    expect(pf2.liveOrderAttestation(CLIENT)!.attestationId).toBe(`op-attest:${CLIENT}`);
    dispose();
  });

  it('a conflicting repeat attestation is rejected (fail closed)', async () => {
    const { deps, fake, live, dispose } = makeDeps();
    await runResolveLiveOrder(deps, BASE_ARGS);
    const pf1 = live.toPortfolio(live.load().data!)!;
    const qtyAfter = pf1.position(SYMBOL)!.quantity.toString();
    // Change BOTH the local ledger order and the exchange order to a DIFFERENT
    // quantity, so the re-run carries a conflicting attested payload.
    const newQty = Money.fromString('0.00020000');
    deps.orders.save(localOrder({ status: 'FILLED', quantity: newQty }));
    fake.seedOrders([exchangeFilled({ quantity: newQty, filledQuantity: newQty })]);
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('attestation_aborted'); // primitive threw "already attested with a different payload"
    expect(pf1.position(SYMBOL)!.quantity.toString()).toBe(qtyAfter); // no double accounting
    dispose();
  });

  it('a symbol mismatch in fresh exchange evidence is rejected', async () => {
    const { deps, dispose } = makeDeps({ fake: makeFakeWithOrder({ symbol: 'ETH/CAD' }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_identity_mismatch');
    dispose();
  });

  it('a side mismatch in fresh exchange evidence is rejected', async () => {
    const { deps, dispose } = makeDeps({ fake: makeFakeWithOrder({ side: 'BUY' }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_identity_mismatch');
    dispose();
  });

  it('a type mismatch in fresh exchange evidence is rejected', async () => {
    const { deps, dispose } = makeDeps({ fake: makeFakeWithOrder({ type: 'market' }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_identity_mismatch');
    dispose();
  });

  it('a requested-quantity mismatch in fresh exchange evidence is rejected', async () => {
    const { deps, dispose } = makeDeps({ fake: makeFakeWithOrder({ quantity: Money.fromString('0.00020000') }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_identity_mismatch');
    dispose();
  });

  it('a limit-price mismatch in fresh exchange evidence is rejected', async () => {
    const { deps, dispose } = makeDeps({ fake: makeFakeWithOrder({ price: Money.fromString('109000.00') }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_identity_mismatch');
    dispose();
  });

  it('a filled-quantity mismatch in fresh exchange evidence is rejected', async () => {
    const { deps, dispose } = makeDeps({ fake: makeFakeWithOrder({ filledQuantity: Money.fromString('0.00020000') }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('quantity_mismatch');
    dispose();
  });

  it('A: GetOrderStatus success uses status evidence', async () => {
    const { deps, live, dispose } = makeDeps();
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    const a = live.toPortfolio(live.load().data!)!.liveOrderAttestation(CLIENT)!;
    expect(a.exchangeEvidence.orderEvidenceSource).toBe('status');
    expect(a.accountingAuthority).toBe('operator_attestation');
    expect(a.provenanceProof).toBe(false);
    dispose();
  });

  it('B: GetOrderStatus ResourceNotFoundError falls back to exact GetOrderHistory match', async () => {
    const { deps, live, dispose } = makeDeps({ fake: new NotFoundHistoryFake([exchangeFilled()]) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    const a = live.toPortfolio(live.load().data!)!.liveOrderAttestation(CLIENT)!;
    expect(a.exchangeEvidence.orderEvidenceSource).toBe('history');
    expect(a.attestedFilledQuantity.toString()).toBe(QTY.toString());
    dispose();
  });

  it('C: history fallback rejects a wrong OrderId', async () => {
    const { deps, dispose } = makeDeps({ fake: new NotFoundHistoryFake([exchangeFilled({ exchangeOrderId: '111111' })]) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_read_failed'); // exact OrderId not present in history
    dispose();
  });

  it('D: history fallback rejects a symbol mismatch', async () => {
    const { deps, dispose } = makeDeps({ fake: new NotFoundHistoryFake([exchangeFilled({ symbol: 'ETH/CAD' })]) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_identity_mismatch');
    dispose();
  });

  it('E: history fallback rejects a side mismatch', async () => {
    const { deps, dispose } = makeDeps({ fake: new NotFoundHistoryFake([exchangeFilled({ side: 'BUY' })]) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_identity_mismatch');
    dispose();
  });

  it('F: history fallback rejects a type mismatch', async () => {
    const { deps, dispose } = makeDeps({ fake: new NotFoundHistoryFake([exchangeFilled({ type: 'market' })]) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_identity_mismatch');
    dispose();
  });

  it('G: history fallback rejects a requested-quantity mismatch', async () => {
    const { deps, dispose } = makeDeps({ fake: new NotFoundHistoryFake([exchangeFilled({ quantity: Money.fromString('0.00020000') })]) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_identity_mismatch');
    dispose();
  });

  it('H: history fallback rejects a limit-price mismatch', async () => {
    const { deps, dispose } = makeDeps({ fake: new NotFoundHistoryFake([exchangeFilled({ price: Money.fromString('109000.00') })]) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_identity_mismatch');
    dispose();
  });

  it('I: history fallback rejects a non-FILLED status', async () => {
    const { deps, dispose } = makeDeps({ fake: new NotFoundHistoryFake([exchangeFilled({ status: 'CANCELED' })]) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('not_filled');
    dispose();
  });

  it('J: history fallback rejects a filled-quantity mismatch', async () => {
    const { deps, dispose } = makeDeps({ fake: new NotFoundHistoryFake([exchangeFilled({ filledQuantity: Money.fromString('0.00020000') })]) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('quantity_mismatch');
    dispose();
  });

  it('K: a non-not-found GetOrderStatus error does NOT fall back to history', async () => {
    const { deps, dispose } = makeDeps({ fake: (() => {
      const f = new FakeExchange();
      f.seedOrders([exchangeFilled()]);
      f.setBalance('BTC', POSITION_AFTER.toString());
      f.setBalance('CAD', '37.99775272');
      f.setFailures({ getOrderStatus: { kind: 'network' } });
      return f;
    })() });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_read_failed'); // arbitrary error, no history fallback
    dispose();
  });

  it('L: an exact correlated trade fee overrides the order-level zero/unknown fee', async () => {
    // order-level fee = 0 / unknown; the correlated trade has a real 0.02399803 CAD fee.
    const { deps, live, dispose } = makeDeps({ fake: makeFeeFake({ feeKind: 'quote' }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    const a = live.toPortfolio(live.load().data!)!.liveOrderAttestation(CLIENT)!;
    expect(a.fee.toString()).toBe('0.02399803');
    expect(a.feeCurrency).toBe('quote');
    dispose();
  });

  it('M: the authoritative quote fee is preserved exactly in accounting', async () => {
    const { deps, live, dispose } = makeDeps({ fake: makeFeeFake({ feeKind: 'quote' }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    const pf = live.toPortfolio(live.load().data!)!;
    const expectedNet = QTY.mul(PRICE).sub(Money.fromString('0.02399803'));
    expect(pf.cash('CAD').toString()).toBe(expectedNet.toString());
    expect(expectedNet.toString()).toBe('11.97501697'); // 11.99901500 gross - 0.02399803 fee
    dispose();
  });

  it('N: unknown/base/third-product/unresolved non-zero fees remain fail-closed', async () => {
    for (const [kind, withResolver] of [['base', true], ['unknown', true], ['other', true], ['quote', false]] as const) {
      const { deps, live, dispose } = makeDeps({ fake: makeFeeFake({ feeKind: kind, withResolver }) });
      const res = await runResolveLiveOrder(deps, BASE_ARGS);
      expect(res.code).toBe(2);
      expect(res.json.error).toBe('fee_unresolved');
      expect(live.toPortfolio(live.load().data!)!.position(SYMBOL)!.quantity.toString()).toBe(POSITION_BEFORE.toString());
      dispose();
    }
  });

  it('O: multiple correlated executions are not arbitrarily collapsed', async () => {
    const { deps, dispose } = makeDeps({ fake: makeFeeFake({
      feeKind: 'quote',
      trades: [correlatedTrade('0.01', { executionId: 'e1', quantity: QTY }), correlatedTrade('0.02', { executionId: 'e2', quantity: QTY })],
    }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('fee_unresolved'); // ambiguous multi-execution fee set
    dispose();
  });

  it('Q: attestation snapshot records the historical-order evidence source', async () => {
    const { deps, live, dispose } = makeDeps({ fake: new NotFoundHistoryFake([exchangeFilled()]) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    const a = live.toPortfolio(live.load().data!)!.liveOrderAttestation(CLIENT)!;
    expect(a.exchangeEvidence.orderEvidenceSource).toBe('history');
    expect(a.exchangeEvidence.status).toBe('FILLED');
    expect(a.exchangeEvidence.quantity.toString()).toBe(QTY.toString());
    expect(a.exchangeEvidence.limitPrice?.toString()).toBe(PRICE.toString());
    dispose();
  });

  it('R: attestation snapshot records execution/trade evidence', async () => {
    const { deps, live, dispose } = makeDeps({ fake: makeFeeFake({ feeKind: 'quote' }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    const a = live.toPortfolio(live.load().data!)!.liveOrderAttestation(CLIENT)!;
    const t = a.exchangeEvidence.observedAccountTrades.find((x) => x.orderId === EXCHANGE_ORDER);
    expect(t).toBeDefined();
    expect(t!.executionId).toBe('25437609');
    expect(t!.tradeId).toBe('15084496');
    expect(t!.feeProductId).toBe('7');
    expect(t!.quantity.toString()).toBe(QTY.toString());
    expect(t!.price.toString()).toBe(PRICE.toString());
    dispose();
  });

  it('S: correct net proceeds include the 0.02399803 CAD fee', async () => {
    const { deps, live, dispose } = makeDeps({ fake: makeFeeFake({ feeKind: 'quote' }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    const pf = live.toPortfolio(live.load().data!)!;
    const expectedNet = QTY.mul(PRICE).sub(Money.fromString('0.02399803'));
    expect(pf.cash('CAD').toString()).toBe(expectedNet.toString());
    // residual CAD (37.99775272) must NOT be adopted.
    expect(pf.cash('CAD').compareTo(Money.fromString('37.99775272'))).toBeLessThan(0);
    dispose();
  });

  it('T: residual CAD is not adopted', async () => {
    const { deps, live, dispose } = makeDeps({ fake: makeFeeFake({ feeKind: 'quote' }) });
    const res = await runResolveLiveOrder(deps, BASE_ARGS);
    expect(res.code).toBe(0);
    const pf = live.toPortfolio(live.load().data!)!;
    expect(pf.cash('CAD').toString()).not.toBe('37.99775272');
    expect(pf.position(SYMBOL)!.sourceQuantities.EXTERNAL_AUTHORIZED.toString()).toBe(POSITION_AFTER.toString());
    expect(pf.position(SYMBOL)!.sourceQuantities.BOT.toString()).toBe('0.00000000');
    dispose();
  });
});
