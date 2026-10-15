# Reconciliation unification (V0 → V1) — design & plan

**Status: IMPLEMENTED (2026-10-15).** The legacy V0 reconciliation path has been
removed; a single V1 path remains. See `docs/DECISIONS.md` §48 for the change
record and validation.

This document records the scoping and rationale for removing the legacy V0
reconciliation path so a single reconciliation implementation remains.

## Background

Two reconciliation paths coexist (see `README.md` → Known Limitations and
`docs/DECISIONS.md` §40):

- **V1** — `reconcile()` / `commitProven()` (`src/reconcile/orchestrator.ts`) plus
  the classifier modules (execution correlation, completeness, fee disposition,
  order/reservation/balance reconciliation, cross-domain), surfaced by
  `bot reconcile` and the action-aware `livePreTradeGate`. This is the primary
  safety path.
- **V0** — `Reconciler` / `ReconcileService` (`src/reconcile/Reconciler.ts`,
  `ReconcileService.ts`, `src/reconcile/types.ts`), the original order/balance
  comparison returning a `ReconcileReport` with `safeToTrade`.

**Behavioral difference:** V1 **surfaces** unexpected external exchange balances;
V0's expected-balance check iterates only the currencies the bot already expects,
so it does **not** surface unexpected currencies. Neither path auto-adopts.

## Findings — where V0 is still load-bearing (usage map)

- `ReconcileService` is constructed in `src/engine/buildLiveEngine.ts` and
  `src/cli/live-test-cmd.ts`, and passed into the `LiveOrderEngine` constructor
  (`src/execution/LiveExecutionEngine.ts`).
- `LiveOrderEngine.reconcile()` is a thin passthrough to
  `ReconcileService.reconcile()` and is **not called anywhere in production**
  (only `tests/unit/execution/liveExecution.test.ts`).
- `src/cli/live-test-cmd.ts` calls `deps.reconcile.reconcile()` **after**
  submission in `executeLiveTest` and `executeLiveBuy`. The return value is
  **ignored** — it is a diagnostic observation (an extra snapshot fetch), not a
  gate.
- V0 types (`ReconcileReport`, `Discrepancy`, `ReconcileOptions`,
  `ExchangeAccountSnapshot`, `LocalOrderLedger`) are imported only within
  `src/reconcile/` and re-exported by the barrel; nothing else in `src/` uses them.
- The gate that actually protects LIVE placement is V1 (`livePreTradeGate`), used
  by both `live-test` and `LiveEngine`.

**Conclusion:** V0 is effectively vestigial in the production path. Its only live
effect is two ignored-return diagnostic reads in `live-test`.

## Proposed plan (phased, behavior-neutral)

1. Replace the two post-submit `deps.reconcile.reconcile()` diagnostics in
   `live-test-cmd` with the V1 `reconcile(deps)` (already imported) so observation
   is unified and unexpected balances are surfaced. No gating change.
2. Remove the `ReconcileService` dependency from `LiveOrderEngine` (constructor
   parameter + the `reconcile()` passthrough) and drop its construction from
   `buildLiveEngine` / `live-test-cmd`.
3. Delete `Reconciler.ts`, `ReconcileService.ts`, `reconcile/types.ts`, their
   barrel exports, and retire the three V0 test files
   (`reconciler.test.ts`, `reconcileService.test.ts`, `ownership-reconcile.test.ts`),
   **after porting** any still-valuable invariants (e.g. negative-balance and
   expected-balance-drift detection) to V1 tests.
4. Update `README.md` / `docs/ARCHITECTURE.md` to state a single reconciliation
   path.

## Risks & mitigations

- **Risk:** removing a check that gates LIVE placement.
  **Mitigation:** the usage map above shows V0's result gates nothing — the
  passthrough is uncalled in production and `live-test` ignores the return. The
  placement gate is V1. Re-verify with a grep for any `discrepancies`/
  `safeToTrade` consumer at implementation time.
- **Risk:** coverage loss.
  **Mitigation:** port V0 balance invariants to V1 tests before deleting V0.
- **Risk:** live-path regression.
  **Mitigation:** keep reads identical, run the full gate, require CI green, and
  keep `supportsOrderPlacement = false` unchanged.

## Non-goals

- No change to V1 semantics, `livePreTradeGate`, or any order-submission path.
- No change to ownership / external-balance adoption.
- No change to manual-bridge or live accounting semantics.

## Validation (when implemented)

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` clean.
- A test proving the live-test post-submit observation uses V1 and that no
  `ReconcileService`/`Reconciler` symbol remains in `src/`.
