# CREATED-order recovery (controlled LIVE)

This is a concise operator procedure for the one ambiguous LIVE state that the
bot cannot resolve by itself: a durable `CREATED` order.

## Why a CREATED order can exist

The controlled LIVE path persists an order as `CREATED` **before** it calls the
exchange (`persist-before-submit`). The sequence is:

```
guard -> validate -> persist CREATED -> SendOrder -> persist result
```

All of this runs under the state-directory mutation lock (P2-3), so two
concurrent processes cannot both submit. The lock does **not** protect against
the process being killed. A crash after `CREATED` is persisted but before (or
around) `SendOrder` leaves a durable `CREATED` order with `exchangeOrderId =
null`.

## Why it is ambiguous

From the durable `CREATED` record alone the bot cannot prove whether NDAX
received the order:

- the submission may or may not have happened;
- NDAX `ClientOrderId` lookup is not supported and its uniqueness is not proven
  (the bot sends `0` by default), so the order cannot be found by our local id;
- heuristic matching by symbol/side/quantity/price is forbidden;
- an exchange `OrderId` is the only reliable exchange identity, and a `CREATED`
  order has none.

A `CREATED` order therefore **blocks all new LIVE placement** until an operator
resolves it. Reconciliation also fails closed while it exists.

## Why automatic retry is unsafe

There is no safe way to decide automatically. Assuming the order was **not**
sent risks a duplicate live order; assuming it **was** sent risks accounting for
an order that does not exist. The bot never retries, resends, or cancels
automatically.

## Inspect the exchange read-only first

Run the operator command (below); it performs read-only reads and prints them:

- open orders for the symbol,
- order history,
- account trades,
- balances.

It never calls SendOrder/CancelOrder and never uses a ClientOrderId lookup. You
can also inspect the NDAX web UI directly.

## Resolve: ATTACH

Use ATTACH when you have identified the **exact** exchange `OrderId` that
belongs to this local `CREATED` order:

```bash
bot resolve-created-order <clientOrderId> \
  --operator <your-name> \
  --attach-exchange-order-id <exchangeOrderId> \
  --confirm
```

The command re-reads that exact exchange order and verifies the identity
(`exchangeOrderId`, symbol, side, type, requested quantity, limit price) against
the durable `CREATED` record. Any mismatch fails closed. On success it attaches
the id and adopts the authoritative exchange status. It does **not** account any
fill: if the order is `FILLED`, finish accounting with the existing
`bot live-monitor` / `bot resolve-live-order` paths.

## Resolve: ABANDON

Use ABANDON when the exchange outcome cannot be determined and you deliberately
want to close the local `CREATED` record:

```bash
bot resolve-created-order <clientOrderId> \
  --operator <your-name> \
  --abandon --reason "<why you are abandoning this record>" \
  --confirm
```

ABANDON sets the order to the terminal local status `ABANDONED` and records the
operator, timestamp, reason, and `provenanceProof=false`. It does **not**:

- prove that no exchange order exists,
- cancel or close any exchange order,
- create any execution/fee/P&L accounting,
- release any reservation.

**ABANDON is a local operator resolution, not an exchange outcome.** A future
live trade must not be treated as proof that an abandoned exchange outcome did
not exist.

## After resolution

- ATTACH leaves the order in the exchange's status; existing monitor/reconcile
  rules apply.
- ABANDON makes the order terminal locally; reconcile no longer treats it as an
  unresolved live order and new placement is no longer blocked by it.
- Repeated resolution of an already-resolved order fails safely; no second
  attestation is created.

## Stale `.mutation.lock`

A crash during the critical section can also leave the canonical
`.mutation.lock` file behind (the lock is fail-closed and is never auto-stolen).
After confirming no mutator is running, remove it manually:

```bash
rm .state/.mutation.lock
```

This is the documented recovery step; the bot never deletes a lock file by
itself.
