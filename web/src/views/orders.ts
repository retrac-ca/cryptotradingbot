/**
 * Orders section. Read-only rendering of the durable order ledger using the
 * ACTUAL lifecycle status strings returned by the API. No trading controls.
 */

import { EMPTY, displayMoney, displayText, formatTimestamp } from '../format.js';
import { badge, orderTone, provenanceLine } from '../status.js';
import type { OrderSnapshot, OrdersSnapshot } from '../types.js';

function fillsCell(order: OrderSnapshot): string {
  if (order.fills.length === 0) return EMPTY;
  const rows = order.fills
    .map(
      (f) => `
      <tr>
        <td class="num">${displayMoney(f.quantity)}</td>
        <td class="num">${displayMoney(f.price)}</td>
        <td class="num">${displayMoney(f.fee)} ${displayText(f.feeCurrency)}</td>
        <td>${displayText(f.executionId)}</td>
        <td>${formatTimestamp(f.timestampMs)}</td>
      </tr>`,
    )
    .join('');
  return `
    <details>
      <summary>${order.fills.length} fill${order.fills.length === 1 ? '' : 's'}</summary>
      <table class="data data--nested">
        <thead>
          <tr><th scope="col">Qty</th><th scope="col">Price</th><th scope="col">Fee</th>
          <th scope="col">Execution</th><th scope="col">Time</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
}

function orderRow(order: OrderSnapshot): string {
  const resolution = order.resolution
    ? `<details><summary>${displayText(order.resolution.kind)}</summary>
        <p class="detail-line">operator: ${displayText(order.resolution.operator)}</p>
        <p class="detail-line">reason: ${displayText(order.resolution.reason)}</p>
        <p class="detail-line">evidence: ${displayText(order.resolution.evidence)}</p>
        <p class="detail-line">resolved: ${formatTimestamp(order.resolution.resolvedAtMs)}</p>
      </details>`
    : EMPTY;
  return `
    <tr>
      <td class="mono">${displayText(order.clientOrderId)}</td>
      <td class="mono">${displayText(order.exchangeOrderId)}</td>
      <td>${displayText(order.symbol)}</td>
      <td>${displayText(order.side)}</td>
      <td>${displayText(order.type)}</td>
      <td class="num">${displayMoney(order.quantity)}</td>
      <td class="num">${displayMoney(order.filledQuantity)}</td>
      <td class="num">${displayMoney(order.averagePrice)}</td>
      <td class="num">${displayMoney(order.limitPrice)}</td>
      <td>${badge(order.status, orderTone(order.status))}</td>
      <td>${fillsCell(order)}</td>
      <td class="num">${displayMoney(order.fee)} ${displayText(order.feeCurrency)}</td>
      <td>${resolution}</td>
      <td>${formatTimestamp(order.createdAtMs)}</td>
      <td>${formatTimestamp(order.updatedAtMs)}</td>
    </tr>`;
}

export function renderOrders(orders: OrdersSnapshot | null, error: string | null): string {
  if (!orders) {
    return `
      <h2 id="orders-heading">Orders</h2>
      <p class="section-error" role="status">ORDERS ${badge('UNAVAILABLE', 'error')} ${
        error ? `— ${displayText(error)}` : ''
      }</p>`;
  }

  if (orders.status === 'MISSING') {
    return `
      <h2 id="orders-heading">Orders</h2>
      <p class="empty">No order ledger recorded yet. ${badge('MISSING', 'unavailable')}</p>
      ${provenanceLine(orders.provenance)}`;
  }
  if (orders.status === 'CORRUPT' || orders.status === 'ERROR') {
    return `
      <h2 id="orders-heading">Orders</h2>
      <p class="section-error" role="status">Order ledger is ${displayText(orders.status)}: ${displayText(
        orders.reason ?? 'unreadable',
      )}</p>
      ${provenanceLine(orders.provenance)}`;
  }

  const list = orders.orders ?? [];
  const table =
    list.length === 0
      ? `<p class="empty">${EMPTY} no orders</p>`
      : `
    <table class="data data--orders">
      <caption class="sr-only">Order ledger (${list.length} orders)</caption>
      <thead>
        <tr>
          <th scope="col">Client order ID</th><th scope="col">Exchange order ID</th>
          <th scope="col">Symbol</th><th scope="col">Side</th><th scope="col">Type</th>
          <th scope="col">Qty</th><th scope="col">Filled</th><th scope="col">Avg price</th>
          <th scope="col">Limit price</th><th scope="col">Status</th><th scope="col">Fills</th>
          <th scope="col">Fees</th><th scope="col">Resolution</th>
          <th scope="col">Created</th><th scope="col">Updated</th>
        </tr>
      </thead>
      <tbody>${list.map(orderRow).join('')}</tbody>
    </table>`;

  return `
    <h2 id="orders-heading">Orders</h2>
    <p class="hint">Unresolved: <strong>${displayText(String(orders.unresolvedCount))}</strong> · Total: ${displayText(
      orders.totalCount === null ? null : String(orders.totalCount),
    )}. Lifecycle states are shown exactly as recorded.</p>
    ${table}
    ${provenanceLine(orders.provenance)}`;
}
