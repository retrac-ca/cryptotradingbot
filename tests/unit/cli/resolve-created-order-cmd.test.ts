/**
 * `bot resolve-created-order` — operator-only ATTACH/ABANDON resolution tests.
 *
 * The critical properties: a durable LIVE CREATED order (exchangeOrderId=null)
 * is fundamentally ambiguous; the command NEVER invokes an exchange write method
 * (SendOrder/CancelOrder), NEVER uses ClientOrderId lookup or heuristic matching,
 * requires explicit operator + confirmation, verifies ATTACH identity exactly,
 * fails closed on read failures / TOCTOU, records an operator-attestation audit
 * with provenanceProof=false, and never accounts an execution.
 */

import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { OrderStore, ManagedStateStore } from '../../../src/persistence/index.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { toReadOnlyAdapter } from '../../../src/cli/manual-cmd.js';
import {
  runResolveCreatedOrder,
  type ResolveCreatedOrderDeps,
} from '../../../src/cli/resolve-created-order-cmd.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';
import type { Order } from '../../../src/order.js';
import type { Balance } from '../../../src/types.js';

const CLIENT = 'live-BTCCAD-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CLIENT = 'live-BTCCAD-22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SYMBOL = 'BTC/CAD';
const QTY = Money.fromString('0.1');
const PRICE = Money.fromString('40000.00');
const NOW = 1_000_000;

function createdOrder(over: Partial<Order> = {}): Order {
  return {
    clientOrderId: CLIENT,
    exchangeOrderId: null,
    symbol: SYMBOL,
    side: 'SELL',
    type: 'limit',
    status: 'CREATED',
    quantity: QTY,
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: PRICE,
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'unknown',
    reason: 'live-test SELL',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  };
}

function exchangeOrder(over: Partial<Order> = {}): Order {
  return {
    clientOrderId: '',
    exchangeOrderId: '555',
    symbol: SYMBOL,
    side: 'SELL',
    type: 'limit',
    status: 'OPEN',
    quantity: QTY,
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: PRICE,
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'unknown',
    reason: '',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  };
}

/** A fake whose getBalances hook can simulate a concurrent ledger mutation. */
class MutatingFake extends FakeExchange {
  beforeBalances?: () => void;
  override async getBalances(): Promise<Balance[]> {
    this.beforeBalances?.();
    return super.getBalances();
  }
}

interface Deps {
  deps: ResolveCreatedOrderDeps;
  fake: FakeExchange;
  orders: OrderStore;
  stateDir: string;
  dispose: () => void;
}

function makeDeps(opts: { fake?: FakeExchange; liveOrder?: Order } = {}): Deps {
  const stateDir = statePath('rco', 'dir');
  const orders = new OrderStore(join(stateDir, 'ledger.json'));
  const fake = opts.fake ?? new FakeExchange();
  orders.save(opts.liveOrder ?? createdOrder());
  const readOnly = toReadOnlyAdapter(fake);
  const deps: ResolveCreatedOrderDeps = {
    cfg: { stateDir },
    adapter: readOnly,
    orders,
    nowMs: () => NOW,
  };
  return { deps, fake, orders, stateDir, dispose: () => rmSync(stateDir, { recursive: true, force: true }) };
}

const ATTACH_ARGS = [CLIENT, '--operator', 'operator-alice', '--attach-exchange-order-id', '555', '--confirm'];
const ABANDON_ARGS = [
  CLIENT,
  '--operator',
  'operator-alice',
  '--abandon',
  '--reason',
  'exchange outcome cannot be determined',
  '--confirm',
];

describe('bot resolve-created-order — refusals (fail closed, no mutation)', () => {
  it('missing order', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveCreatedOrder(deps, ['live-BTCCAD-missing', '--operator', 'x', '--abandon', '--reason', 'r', '--confirm']);
    expect(res.code).toBe(1);
    expect(res.json.error).toBe('order_not_found');
    dispose();
  });

  it('non-CREATED order', async () => {
    const { deps, dispose } = makeDeps({ liveOrder: createdOrder({ status: 'SUBMITTED', exchangeOrderId: '999' }) });
    const res = await runResolveCreatedOrder(deps, ATTACH_ARGS);
    expect(res.code).toBe(1);
    expect(res.json.error).toBe('not_created');
    dispose();
  });

  it('CREATED order that already has an exchangeOrderId', async () => {
    const { deps, dispose } = makeDeps({ liveOrder: createdOrder({ exchangeOrderId: '999' }) });
    const res = await runResolveCreatedOrder(deps, ATTACH_ARGS);
    expect(res.code).toBe(1);
    expect(res.json.error).toBe('already_has_exchange_id');
    dispose();
  });

  it('missing operator', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveCreatedOrder(deps, [CLIENT, '--attach-exchange-order-id', '555', '--confirm']);
    expect(res.code).toBe(1);
    expect(String(res.json.error)).toMatch(/--operator/);
    dispose();
  });

  it('missing explicit confirmation', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveCreatedOrder(deps, [CLIENT, '--operator', 'x', '--abandon', '--reason', 'r']);
    expect(res.code).toBe(1);
    expect(String(res.json.error)).toMatch(/--confirm/);
    dispose();
  });

  it('both resolution modes', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveCreatedOrder(deps, [
      CLIENT, '--operator', 'x', '--attach-exchange-order-id', '555', '--abandon', '--reason', 'r', '--confirm',
    ]);
    expect(res.code).toBe(1);
    expect(String(res.json.error)).toMatch(/exactly one resolution/);
    dispose();
  });

  it('neither resolution mode', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveCreatedOrder(deps, [CLIENT, '--operator', 'x', '--confirm']);
    expect(res.code).toBe(1);
    expect(String(res.json.error)).toMatch(/a resolution is required/);
    dispose();
  });

  it('abandon without a reason', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveCreatedOrder(deps, [CLIENT, '--operator', 'x', '--abandon', '--confirm']);
    expect(res.code).toBe(1);
    expect(String(res.json.error)).toMatch(/--reason/);
    dispose();
  });

  it('malformed exchange order id', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveCreatedOrder(deps, [CLIENT, '--operator', 'x', '--attach-exchange-order-id', 'abc', '--confirm']);
    expect(res.code).toBe(1);
    expect(String(res.json.error)).toMatch(/not a valid exchange OrderId/);
    dispose();
  });

  it('unknown flags (no --yes/--force bypass)', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveCreatedOrder(deps, [CLIENT, '--operator', 'x', '--abandon', '--reason', 'r', '--confirm', '--force']);
    expect(res.code).toBe(1);
    expect(String(res.json.error)).toMatch(/unknown argument "--force"/);
    dispose();
  });
});

describe('bot resolve-created-order — ATTACH (operator-asserted identity)', () => {
  it('exact identity match attaches the exchange order and adopts its status', async () => {
    const fake = new FakeExchange();
    fake.seedOrders([exchangeOrder({ exchangeOrderId: '555', status: 'OPEN' })]);
    const { deps, orders, dispose } = makeDeps({ fake });
    const res = await runResolveCreatedOrder(deps, ATTACH_ARGS);
    expect(res.code).toBe(0);
    expect(res.json.outcome).toBe('ATTACH');
    const reloaded = orders.get(CLIENT)!;
    expect(reloaded.status).toBe('OPEN');
    expect(reloaded.exchangeOrderId).toBe('555');
    expect(reloaded.clientOrderId).toBe(CLIENT);
    expect(reloaded.resolution?.kind).toBe('ATTACH');
    expect(reloaded.resolution?.operator).toBe('operator-alice');
    expect(reloaded.resolution?.resolvedAtMs).toBe(NOW);
    expect(reloaded.resolution?.accountingAuthority).toBe('operator_attestation');
    expect(reloaded.resolution?.provenanceProof).toBe(false);
    expect(reloaded.resolution?.exchangeOrderId).toBe('555');
    dispose();
  });

  it('symbol mismatch fails closed', async () => {
    const fake = new FakeExchange();
    fake.seedOrders([exchangeOrder({ symbol: 'ETH/CAD' })]);
    const { deps, orders, dispose } = makeDeps({ fake });
    const res = await runResolveCreatedOrder(deps, ATTACH_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_identity_mismatch');
    expect(res.json.field).toBe('symbol');
    expect(orders.get(CLIENT)!.status).toBe('CREATED');
    dispose();
  });

  it('side mismatch fails closed', async () => {
    const fake = new FakeExchange();
    fake.seedOrders([exchangeOrder({ side: 'BUY' })]);
    const { deps, orders, dispose } = makeDeps({ fake });
    const res = await runResolveCreatedOrder(deps, ATTACH_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.field).toBe('side');
    expect(orders.get(CLIENT)!.status).toBe('CREATED');
    dispose();
  });

  it('type mismatch fails closed', async () => {
    const fake = new FakeExchange();
    fake.seedOrders([exchangeOrder({ type: 'market', price: null })]);
    const { deps, orders, dispose } = makeDeps({ fake });
    const res = await runResolveCreatedOrder(deps, ATTACH_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.field).toBe('type');
    expect(orders.get(CLIENT)!.status).toBe('CREATED');
    dispose();
  });

  it('quantity mismatch fails closed', async () => {
    const fake = new FakeExchange();
    fake.seedOrders([exchangeOrder({ quantity: Money.fromString('0.2') })]);
    const { deps, orders, dispose } = makeDeps({ fake });
    const res = await runResolveCreatedOrder(deps, ATTACH_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.field).toBe('quantity');
    expect(orders.get(CLIENT)!.status).toBe('CREATED');
    dispose();
  });

  it('limit price mismatch fails closed', async () => {
    const fake = new FakeExchange();
    fake.seedOrders([exchangeOrder({ price: Money.fromString('40001.00') })]);
    const { deps, orders, dispose } = makeDeps({ fake });
    const res = await runResolveCreatedOrder(deps, ATTACH_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.field).toBe('limit price');
    expect(orders.get(CLIENT)!.status).toBe('CREATED');
    dispose();
  });

  it('read failure fails closed (no mutation)', async () => {
    const fake = new FakeExchange();
    fake.setFailures({ getOrderStatus: { kind: 'network' } });
    const { deps, orders, dispose } = makeDeps({ fake });
    const res = await runResolveCreatedOrder(deps, ATTACH_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('exchange_read_failed');
    expect(orders.get(CLIENT)!.status).toBe('CREATED');
    dispose();
  });

  it('never calls SendOrder or CancelOrder (read-only)', async () => {
    const fake = new FakeExchange();
    fake.seedOrders([exchangeOrder({ exchangeOrderId: '555', status: 'OPEN' })]);
    const place = vi.spyOn(fake, 'placeOrder');
    const cancel = vi.spyOn(fake, 'cancelOrder');
    const { deps, dispose } = makeDeps({ fake });
    const res = await runResolveCreatedOrder(deps, ATTACH_ARGS);
    expect(res.code).toBe(0);
    expect(place).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(fake.submittedOrders).toHaveLength(0);
    dispose();
  });
});

describe('bot resolve-created-order — ABANDON (local operator resolution)', () => {
  it('produces ABANDONED and records the operator-attestation audit', async () => {
    const { deps, orders, dispose } = makeDeps();
    const res = await runResolveCreatedOrder(deps, ABANDON_ARGS);
    expect(res.code).toBe(0);
    expect(res.json.outcome).toBe('ABANDON');
    const reloaded = orders.get(CLIENT)!;
    expect(reloaded.status).toBe('ABANDONED');
    expect(reloaded.exchangeOrderId).toBeNull();
    expect(reloaded.quantity.equals(QTY)).toBe(true);
    expect(reloaded.resolution?.kind).toBe('ABANDON');
    expect(reloaded.resolution?.operator).toBe('operator-alice');
    expect(reloaded.resolution?.reason).toBe('exchange outcome cannot be determined');
    expect(reloaded.resolution?.resolvedAtMs).toBe(NOW);
    expect(reloaded.resolution?.accountingAuthority).toBe('operator_attestation');
    expect(reloaded.resolution?.provenanceProof).toBe(false);
    expect(reloaded.resolution?.exchangeOrderId).toBeNull();
    dispose();
  });

  it('does not create execution accounting or release unrelated reservations', async () => {
    const { deps, stateDir, dispose } = makeDeps();
    const live = new ManagedStateStore(join(stateDir, 'live.json'));
    const before = Portfolio.empty(new Map([['CAD', Money.fromString('1000')]]))
      .reserveOrder(OTHER_CLIENT, 'CAD', Money.fromString('300'));
    live.save(before.stateModel);
    const res = await runResolveCreatedOrder(deps, ABANDON_ARGS);
    expect(res.code).toBe(0);
    const after = live.toPortfolio(live.load().data!)!;
    expect(after.orderReservation(OTHER_CLIENT)?.status).toBe('ACTIVE');
    expect(after.orderReservation(OTHER_CLIENT)?.remaining.toString()).toBe('300.00000000');
    expect(after.liveOrderAttestation(CLIENT)).toBeNull();
    expect(after.appliedCount()).toBe(0);
    dispose();
  });

  it('never calls SendOrder or CancelOrder (read-only)', async () => {
    const fake = new FakeExchange();
    const place = vi.spyOn(fake, 'placeOrder');
    const cancel = vi.spyOn(fake, 'cancelOrder');
    const { deps, dispose } = makeDeps({ fake });
    const res = await runResolveCreatedOrder(deps, ABANDON_ARGS);
    expect(res.code).toBe(0);
    expect(place).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    dispose();
  });

  it('output explicitly states ABANDON does not prove exchange non-existence', async () => {
    const { deps, dispose } = makeDeps();
    const res = await runResolveCreatedOrder(deps, ABANDON_ARGS);
    expect(res.code).toBe(0);
    const text = res.lines.join('\n');
    expect(text).toMatch(/NOT proof that no exchange order exists/i);
    expect(text).toMatch(/LOCAL OPERATOR RESOLUTION/);
    dispose();
  });
});

describe('bot resolve-created-order — TOCTOU, idempotency, mutation lock', () => {
  it('aborts safely when the order changes after the initial read', async () => {
    const fake = new MutatingFake();
    const { deps, orders, stateDir, dispose } = makeDeps({ fake });
    fake.beforeBalances = () => {
      orders.save(createdOrder({ reason: 'changed concurrently' }));
    };
    const res = await runResolveCreatedOrder(deps, ABANDON_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('resolution_aborted');
    expect(orders.get(CLIENT)!.status).toBe('CREATED');
    // The mutation lock is released on the exception path.
    expect(existsSync(join(stateDir, '.mutation.lock'))).toBe(false);
    dispose();
  });

  it('a repeated ABANDON fails safely (already resolved)', async () => {
    const { deps, orders, dispose } = makeDeps();
    expect((await runResolveCreatedOrder(deps, ABANDON_ARGS)).code).toBe(0);
    const again = await runResolveCreatedOrder(deps, ABANDON_ARGS);
    expect(again.code).toBe(1);
    expect(again.json.error).toBe('not_created');
    expect(orders.get(CLIENT)!.resolution?.kind).toBe('ABANDON');
    dispose();
  });

  it('a repeated ATTACH fails safely (already resolved)', async () => {
    const fake = new FakeExchange();
    fake.seedOrders([exchangeOrder({ exchangeOrderId: '555', status: 'OPEN' })]);
    const { deps, orders, dispose } = makeDeps({ fake });
    expect((await runResolveCreatedOrder(deps, ATTACH_ARGS)).code).toBe(0);
    const again = await runResolveCreatedOrder(deps, ATTACH_ARGS);
    expect(again.code).toBe(1);
    expect(again.json.error).toBe('not_created');
    expect(orders.get(CLIENT)!.status).toBe('OPEN');
    dispose();
  });

  it('a competing external mutation lock fails safely (no mutation)', async () => {
    const { deps, orders, stateDir, dispose } = makeDeps();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.mutation.lock'), JSON.stringify({ pid: 999999, createdAtMs: NOW }));
    const res = await runResolveCreatedOrder(deps, ABANDON_ARGS);
    expect(res.code).toBe(2);
    expect(res.json.error).toBe('resolution_aborted');
    expect(orders.get(CLIENT)!.status).toBe('CREATED');
    rmSync(join(stateDir, '.mutation.lock'), { force: true });
    dispose();
  });
});
