/**
 * ManualTradeBridge — orchestrates the manual-execution workflow (Gate 9).
 *
 * RETRAC NEVER submits or cancels an order here. It:
 *   1. evaluates a candidate with the normal RiskManager controls,
 *   2. records a PROPOSED intent + the governing risk snapshot,
 *   3. lets the operator CONFIRM (and, separately, later record evidence),
 *   4. captures the operator-returned execution evidence,
 *   5. SETTLES only after validating the evidence against an authoritative
 *      exchange read, via the distinct ORDER-LEVEL manual accounting path
 *      (`Portfolio.settleManualOrder`),
 *   6. releases/keeps reservations conservatively and reconciles.
 *
 * Guarantees the bridge maintains:
 *   - It NEVER fabricates an execution identity.
 *   - It NEVER treats an exchange `OrderId` as an execution identity.
 *   - Operator-entered values are HINTS; authority must come from an exchange read.
 *   - A reservation is NEVER released/consumed on an unsupported assumption; a
 *     contradiction keeps it reserved (fail closed).
 *   - A manual accounting action requires an explicit operator acknowledgement
 *     (`confirmSettle`) and is recorded in the audit trail.
 *   - An exchange `OrderId` is checked against the intent only via authoritative
 *     fields (`bindOrderToIntent`); this is CONSISTENCY validation, NOT provenance
 *     proof (no NDAX field proves an order belongs to a RETRAC intent). A merely
 *     "similar" order fails closed and is never "owned" just because it was typed.
 *   - Only an authoritative, quote-denominated exchange fee is accounted; base/
 *     missing/modelled/unknown fees fail closed and route the intent to
 *     RECONCILIATION_REQUIRED (NOT an accounting-success state, NOT AMBIGUOUS).
 *   - Accounting authority is EXPLICIT and never overloaded: the terminal success
 *     state is ACCOUNTED_WITH_EXCHANGE_VALIDATION when the numbers came from
 *     authoritative exchange evidence, or ACCOUNTED_WITH_OPERATOR_ATTESTATION when
 *     accounting depends on operator attestation. In BOTH cases `provenanceProof`
 *     is `false` — accounting is never exchange-proven provenance.
 *   - ACCOUNTED_* states are terminal AND idempotent: no second accounting, and a
 *     conflicting repeat fails closed.
 *
 * Identity separation enforced:
 *   - intentId (`manual-<uuid>`): RETRAC logical intent id — NEVER an exchange id.
 *   - orderId : the exchange OrderId captured as evidence — NEVER the accounting key.
 *   - execution id : NONE is fabricated. Accounting is ORDER-level.
 *   - provenance proof : NONE exists; `provenanceProof` is always `false`.
 */

import { randomUUID } from 'node:crypto';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import { Money } from '../money/Money.js';
import type { Order } from '../order.js';
import type { Portfolio } from '../portfolio/Portfolio.js';
import type { RiskManager } from '../risk/RiskManager.js';
import type { RiskContext } from '../risk/RiskContext.js';
import type { RiskApproval } from '../risk/Reason.js';
import { ManualIntentStore } from './ManualIntentStore.js';
import {
  evidenceProgressConflict,
  validateEvidenceAgainstExchange,
  validateEvidenceStructural,
} from './validation.js';
import {
  isAccountedStatus,
  isTerminalManualStatus,
} from './types.js';
import type {
  AccountingAuthority,
  ManualEvidence,
  ManualProposeOptions,
  ManualReconcileIssue,
  ManualReconcileReport,
  ManualRiskSnapshot,
  ManualTradeIntent,
  ProposalResult,
  RecordEvidenceInput,
  SettleOutcome,
} from './types.js';

export interface ManualBridgeDeps {
  intentStore: ManualIntentStore;
  /** Accessor for the CURRENT live-managed `Portfolio` (immutable, replaced on each mutation). */
  getPortfolio: () => Portfolio;
  /** Persist a mutated `Portfolio` (e.g. reservation / settlement accounting). */
  savePortfolio: (p: Portfolio) => void;
  riskManager: RiskManager;
  /** Read-only exchange adapter used ONLY for authoritative reads (never place/cancel). */
  adapter: ExchangeAdapter;
  nowMs?: () => number;
  /** Optional system/operator label attached to audit events. */
  operator?: string;
}

export interface SettleOptions {
  /** Explicit operator acknowledgement that this manual settlement is deliberate. */
  confirmSettle: boolean;
  /**
   * The ACCOUNTING AUTHORITY that dictates the recorded numbers. Default
   * `'exchange'` => ACCOUNTED_WITH_EXCHANGE_VALIDATION (authoritative exchange
   * evidence, including an authoritative quote fee). `'operator_attestation'`
   * => ACCOUNTED_WITH_OPERATOR_ATTESTATION (relies on operator attestation for
   * intent-to-order attribution; exchange consistency is still validated).
   * Either value is NEVER a provenance proof (`provenanceProof` stays false).
   */
  accountingAuthority?: AccountingAuthority;
  /** Operator identity for the audit trail. */
  operator?: string;
}

export interface CancelOptions {
  /** Explicit operator acknowledgement before releasing a reservation. */
  confirmCancel: boolean;
  operator?: string;
  reason?: string;
}

function fractionOf(amount: Money, fraction: number): Money {
  const scale = 1_000_000_000n;
  const num = BigInt(Math.round(fraction * Number(scale)));
  return amount.mulFraction(num, scale);
}

export class ManualTradeBridge {
  private readonly deps: ManualBridgeDeps;

  constructor(deps: ManualBridgeDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  // --- internal mutagenic helpers ---

  private pushEvent(intent: ManualTradeIntent, type: string, actor: 'operator' | 'system', detail?: string): ManualTradeIntent {
    const events = [...intent.events, {
      ts: this.now(),
      type,
      actor,
      ...(detail !== undefined ? { detail } : {}),
    }];
    return { ...intent, events, updatedAtMs: this.now() };
  }

  private save(intent: ManualTradeIntent): ManualTradeIntent {
    this.deps.intentStore.save(intent);
    return intent;
  }

  // --- public API ---

  get(intentId: string): ManualTradeIntent | null {
    return this.deps.intentStore.get(intentId);
  }

  list(): ManualTradeIntent[] {
    return [...this.deps.intentStore.allIntents().values()];
  }

  /**
   * Generate a durable, collision-resistant logical intent id. NEVER derived
   * from order fields, prices, timestamps, or exchange ids.
   */
  newIntentId(): string {
    return `manual-${randomUUID()}`;
  }

  /**
   * Evaluate a candidate with the RiskManager and, if approved, record a
   * PROPOSED intent (+ risk snapshot) and (BUY) reserve the required quote.
   *
   * The final quantity/side come from the RiskManager's approved decision, never
   * from a caller-supplied raw quantity. A BUY reserves `notional + fee` via the
   * order-linked reservation so the same managed quote can never fund two trades.
   */
  propose(ctx: RiskContext, opts: ManualProposeOptions): ProposalResult {
    const decision = this.deps.riskManager.evaluate(ctx);
    if (!decision.approved) {
      return { ok: false, reason: decision.reason, decision };
    }
    const approval = decision;
    const reserveR = this.buildRiskSnapshot(ctx, approval, opts);
    const intentId = this.newIntentId();
    const now = this.now();

    let portfolio = this.deps.getPortfolio();
    let reservationCurrency: string | null = null;
    let reservationAmount: Money | null = null;
    if (approval.side === 'BUY') {
      const quote = ctx.symbol.split('/')[1] ?? 'CAD';
      try {
        portfolio = portfolio.reserveOrder(intentId, quote, reserveR.requiredBalance);
        reservationCurrency = quote;
        reservationAmount = reserveR.requiredBalance;
      } catch (err) {
        return {
          ok: false,
          reason: `could not reserve quote: ${err instanceof Error ? err.message : String(err)}`,
          decision,
        };
      }
    } else {
      // SELL: no quote reservation, but the managed position must cover the sell.
      const managed = portfolio.position(ctx.symbol)?.quantity ?? Money.zero();
      if (approval.quantity.compareTo(managed) > 0) {
        return {
          ok: false,
          reason: `SELL quantity ${approval.quantity} exceeds managed position ${managed}`,
          decision,
        };
      }
    }
    this.deps.savePortfolio(portfolio);

    const intent: ManualTradeIntent = {
      intentId,
      status: 'PROPOSED',
      symbol: ctx.symbol,
      side: approval.side,
      type: opts.limitPrice ? 'limit' : 'market',
      quantity: approval.quantity,
      limitPrice: opts.limitPrice ?? null,
      tif: null,
      reason: opts.reason,
      riskSnapshot: reserveR,
      evidence: null,
      operatorConfirmedBy: null,
      createdAtMs: now,
      updatedAtMs: now,
      events: [{ ts: now, type: 'propose', actor: 'system', detail: `risk-approved ${approval.side} ${approval.quantity} @ ${approval.price}` }],
      reservationCurrency,
      reservationAmount,
    };
    this.save(intent);
    return { ok: true, intent };
  }

  /**
   * Operator confirms the proposal explicitly. PROPOSED -> CONFIRMED.
   */
  confirm(intentId: string, operator?: string): ManualTradeIntent {
    const intent = this.deps.intentStore.get(intentId);
    if (!intent) throw new Error(`manual intent ${intentId} not found`);
    if (intent.status !== 'PROPOSED') {
      throw new Error(`manual intent ${intentId} cannot be confirmed from status ${intent.status}`);
    }
    const updated = this.pushEvent(intent, 'confirm', 'operator', operator ? `confirmed by ${operator}` : 'confirmed');
    updated.status = 'CONFIRMED';
    updated.operatorConfirmedBy = operator ?? this.deps.operator ?? null;
    return this.save(updated);
  }

  /**
   * Capture operator-returned execution evidence.
   *
   * Fail closed on a conflicting update: a previously terminal evidence record is
   * never silently overwritten by a different terminal state. On a conflict the
   * new evidence is rejected and an audit event records the attempt.
   */
  recordEvidence(intentId: string, input: RecordEvidenceInput): ManualTradeIntent {
    const intent = this.deps.intentStore.get(intentId);
    if (!intent) throw new Error(`manual intent ${intentId} not found`);
    // Terminal accounted/non-accounted states can never have evidence re-recorded.
    if (isTerminalManualStatus(intent.status)) {
      throw new Error(`manual intent ${intentId} is terminal (${intent.status}); evidence cannot change`);
    }
    // A new authoritative/explicitly attested evidence path MAY resolve an
    // AMBIGUOUS or RECONCILIATION_REQUIRED intent, so those are allowed; only a
    // not-yet-confirmed PROPOSED intent is forbidden from recording evidence.
    if (intent.status === 'PROPOSED') {
      throw new Error(
        `manual intent ${intentId} must be confirmed before evidence can be recorded; ` +
          'a settlement requires an explicit operator confirmation first',
      );
    }

    const evidence: ManualEvidence = {
      orderId: input.orderId ?? null,
      status: input.status ?? null,
      filledQuantity: input.filledQuantity ?? null,
      averagePrice: input.averagePrice ?? null,
      fee: input.fee ?? null,
      feeCurrency: input.feeCurrency ?? 'quote',
      evidenceSource: input.evidenceSource ?? 'operator',
      recordedAtMs: this.now(),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };

    if (intent.evidence) {
      const conflict = evidenceProgressConflict(intent.evidence, evidence);
      if (conflict) {
        const withEvent = this.pushEvent(intent, 'evidence_conflict', 'system', `${conflict}; rejected`);
        this.save(withEvent);
        throw new Error(`manual intent ${intentId}: ${conflict}`);
      }
    }

    const updated: ManualTradeIntent = {
      ...this.pushEvent(intent, 'evidence', 'operator', `status=${evidence.status ?? 'n/a'} orderId=${evidence.orderId ?? 'n/a'} filled=${evidence.filledQuantity ?? 'n/a'}`),
      evidence,
      status: 'EVIDENCE_RECORDED',
    };
    return this.save(updated);
  }

  /**
   * Validate + account a manual execution at the ORDER level.
   *
   * Requires explicit `confirmSettle` and evidence that is BOTH structurally
   * valid and CONFIRMED against an authoritative exchange read, plus an
   * authoritative quote-denominated fee. Outcomes (all fail closed):
   *  - ACCOUNTED_WITH_EXCHANGE_VALIDATION / ACCOUNTED_WITH_OPERATOR_ATTESTATION:
   *    accounting applied exactly once (accounting authority per `opts`).
   *  - PENDING: exchange order is not yet terminal; reservation retained.
   *  - RECONCILIATION_REQUIRED: evidence consistent but accounting cannot be
   *    safely completed (unreadable exchange, missing/unrelated OrderId, fee
   *    currency unknown/base/other when a fee exists) — NO accounting applied,
   *    reservation retained.
   *  - AMBIGUOUS: evidence actually CONTRADICTS (structural failure, exchange
   *    conflict, invariant violation) — reservation retained.
   *  - CANCELED_TERMINAL_NO_FILL: terminal zero-fill; reservation released once.
   */
  async settle(intentId: string, opts: SettleOptions): Promise<SettleOutcome> {
    if (!opts.confirmSettle) {
      const intent = this.deps.intentStore.get(intentId);
      if (!intent) throw new Error(`manual intent ${intentId} not found`);
      return { outcome: 'REFUSED', intent, reason: 'settlement requires explicit operator confirmation (confirmSettle)' };
    }
    const intent = this.deps.intentStore.get(intentId);
    if (!intent) throw new Error(`manual intent ${intentId} not found`);
    // May settle from any evidence-holding, not-yet-terminal-accounted state so a
    // PENDING or RECONCILIATION_REQUIRED order can be retried once it resolves.
    const settable = intent.status === 'EVIDENCE_RECORDED' || intent.status === 'PENDING' || intent.status === 'RECONCILIATION_REQUIRED';
    if (!settable || !intent.evidence) {
      return { outcome: 'REFUSED', intent, reason: 'evidence must be recorded before settlement (and the intent must not be terminal)' };
    }
    const mode: 'exchange_validated' | 'operator_attested' =
      opts.accountingAuthority === 'operator_attestation' ? 'operator_attested' : 'exchange_validated';
    const evidence = intent.evidence;

    const structural = validateEvidenceStructural(intent, evidence);
    if (!structural.ok) {
      const marked = this.pushEvent(intent, 'settle_blocked', 'system', `structural: ${structural.reason}`);
      marked.status = 'AMBIGUOUS';
      this.save(marked);
      return { outcome: 'AMBIGUOUS', intent: marked, reason: structural.reason ?? 'structural validation failed' };
    }

    const v = await validateEvidenceAgainstExchange(this.deps.adapter, intent, evidence);
    if (!v.ok) {
      // Contradictory evidence (operator vs exchange mismatch, binding failure,
      // over-fill) is AMBIGUOUS. A NON-conflicting inability (read failure, no
      // OrderId) means we cannot safely determine the accounting => RECONCILIATION_REQUIRED.
      if (v.conflict) {
        const marked = this.pushEvent(intent, 'settle_blocked', 'system', `exchange: ${v.reason}`);
        marked.status = 'AMBIGUOUS';
        this.save(marked);
        return { outcome: 'AMBIGUOUS', intent: marked, reason: v.reason ?? 'exchange validation failed' };
      }
      const marked = this.pushEvent(intent, 'settle_blocked', 'system', `exchange-unreadable: ${v.reason}`);
      marked.status = 'RECONCILIATION_REQUIRED';
      this.save(marked);
      return { outcome: 'RECONCILIATION_REQUIRED', intent: marked, reason: v.reason ?? 'cannot validate against the exchange' };
    }
    if (v.pending || !v.authoritative) {
      const marked = this.pushEvent(intent, 'settle_pending', 'system', `order not yet terminal (${intent.evidence?.status ?? 'unknown'}); reservation stays reserved`);
      marked.status = 'PENDING';
      this.save(marked);
      return { outcome: 'PENDING', intent: marked, reason: 'order is not yet terminal (may still fill); reservation stays reserved' };
    }
    const authoritative = v.authoritative;

    // Authoritative disposition (exchange governs).
    if (!authoritative.filledQuantity.isPositive()) {
      // Terminal no-fill: release the reservation (if any), mark canceled.
      let pf = this.deps.getPortfolio();
      if (pf.orderReservation(intentId)) {
        pf = pf.releaseOrderReservation(intentId);
        this.deps.savePortfolio(pf);
      }
      const marked = this.pushEvent(intent, 'settle_release', 'system', `terminal no-fill (${authoritative.status}); reservation released`);
      marked.status = 'CANCELED';
      this.save(marked);
      return { outcome: 'CANCELED_TERMINAL_NO_FILL', intent: marked, reason: `order ${authoritative.status} with no fill; reservation released` };
    }

    if (authoritative.filledQuantity.compareTo(intent.quantity) > 0) {
      const marked = this.pushEvent(intent, 'settle_blocked', 'system', `authoritative fill ${authoritative.filledQuantity} > proposed ${intent.quantity}`);
      marked.status = 'AMBIGUOUS';
      this.save(marked);
      return { outcome: 'AMBIGUOUS', intent: marked, reason: 'authoritative fill exceeds proposed quantity' };
    }
    const price = authoritative.averagePrice;
    if (!price || !price.isPositive()) {
      const marked = this.pushEvent(intent, 'settle_blocked', 'system', 'authoritative order has no positive average price');
      marked.status = 'AMBIGUOUS';
      this.save(marked);
      return { outcome: 'AMBIGUOUS', intent: marked, reason: 'cannot settle without an authoritative average price' };
    }

    // Resolve the fee. Only an AUTHORITATIVE, quote-denominated exchange fee is
    // safe to account. A base-denominated fee, an unknown-currency fee, a zero /
    // missing fee, or a modelled/operator value all FAIL CLOSED into
    // RECONCILIATION_REQUIRED — never reinterpreted as quote, never assumed, never
    // an accounting backdoor.
    const feeResolution = this.resolveAuthoritativeFee(authoritative);
    if (!feeResolution.ok) {
      const marked = this.pushEvent(intent, 'settle_blocked', 'system', `fee: ${feeResolution.reason}; automatic accounting refused -> RECONCILIATION_REQUIRED`);
      marked.status = 'RECONCILIATION_REQUIRED';
      this.save(marked);
      return { outcome: 'RECONCILIATION_REQUIRED', intent: marked, reason: feeResolution.reason };
    }
    const fee = feeResolution.fee;

    const accountedStatus = mode === 'operator_attested' ? 'ACCOUNTED_WITH_OPERATOR_ATTESTATION' : 'ACCOUNTED_WITH_EXCHANGE_VALIDATION';
    try {
      let pf = this.deps.getPortfolio();
      pf = pf.settleManualOrder({
        intentId,
        symbol: intent.symbol,
        side: intent.side,
        quantity: authoritative.filledQuantity,
        price,
        fee,
        orderId: evidence.orderId,
        evidenceSource: evidence.evidenceSource,
        exchangedValidated: true,
        settlementMode: mode,
        provenanceProof: false,
        operatorConfirmedBy: opts.operator ?? this.deps.operator ?? null,
        executedAtMs: authoritative.updatedAtMs,
      });
      this.deps.savePortfolio(pf);
    } catch (err) {
      // An accounting invariant failure (e.g. a conflicting repeat, an over-fill
      // past the reservation) is a genuine contradiction => AMBIGUOUS.
      const marked = this.pushEvent(intent, 'settle_blocked', 'system', `accounting: ${err instanceof Error ? err.message : String(err)}; reservation left reserved`);
      marked.status = 'AMBIGUOUS';
      this.save(marked);
      return { outcome: 'AMBIGUOUS', intent: marked, reason: err instanceof Error ? err.message : String(err) };
    }

    const settled: ManualTradeIntent = {
      ...this.pushEvent(intent, 'settle', 'operator', `accounted via ${mode}: ${authoritative.filledQuantity} @ ${price} fee ${fee}`),
      status: accountedStatus,
    };
    this.save(settled);
    const settlement = this.deps.getPortfolio().manualSettlement(intentId);
    return { outcome: accountedStatus, intent: settled, settlement: settlement! };
  }

  /**
   * Cancel a manual intent before execution / release an un-filled reservation.
   *
   * Requires explicit `confirmCancel`. Releases a BUY reservation only when the
   * evidence standard is met: no evidence of a positive fill. A reservation is
   * NEVER released while there is any reported fill (an order that may have
   * partially filled must go through `settle`). Reconciliation afterward catches
   * a mistaken release (fail-safe).
   */
  cancel(intentId: string, opts: CancelOptions): ManualTradeIntent {
    if (!opts.confirmCancel) {
      throw new Error('manual cancel requires explicit operator confirmation (confirmCancel)');
    }
    const intent = this.deps.intentStore.get(intentId);
    if (!intent) throw new Error(`manual intent ${intentId} not found`);
    if (isTerminalManualStatus(intent.status)) {
      throw new Error(`manual intent ${intentId} is terminal (${intent.status}); cannot cancel`);
    }
    // Cancel is only a valid operator action on a not-yet-executed / no-fill
    // proposal. A PENDING (may still fill), AMBIGUOUS, or RECONCILIATION_REQUIRED
    // order may have a positive external execution and is NEVER silently canceled
    // (recall: cancel releases a reservation only when no positive fill exists).
    if (intent.status !== 'PROPOSED' && intent.status !== 'CONFIRMED' && intent.status !== 'EVIDENCE_RECORDED') {
      throw new Error(
        `manual intent ${intentId} is ${intent.status}; it must be resolved (settle/reconcile) before it can be canceled — ` +
          'a reservation is never silently released on a pending/ambiguous/reconciliation order',
      );
    }
    if (intent.evidence?.filledQuantity?.isPositive()) {
      throw new Error(
        `manual intent ${intentId} has a reported fill (${intent.evidence.filledQuantity}); must settle, not cancel`,
      );
    }
    let pf = this.deps.getPortfolio();
    if (pf.orderReservation(intentId)) {
      pf = pf.releaseOrderReservation(intentId);
      this.deps.savePortfolio(pf);
    }
    const updated = this.pushEvent(
      intent,
      'cancel',
      'operator',
      `${opts.reason ?? 'canceled'}${pf.orderReservation(intentId) ? '' : '; reservation released'}`,
    );
    updated.status = 'CANCELED';
    return this.save(updated);
  }

  /**
   * Determine the state-machine + two-store (portfolio / intent) recovery
   * inconsistencies and apply only the DETERMINISTIC, safe repairs.
   *
   * `propose`, `confirm`, `recordEvidence`, `cancel` and `settle` each cross two
   * separate durable files (portfolio state and the manual-intent store). There is
   * NO cross-file atomicity, so a crash between them can leave the bridges
   * inconsistent. This pass makes the state machine RECOVERABLE rather than
   * pretending the files are transactional.
   *
   * Detected + repaired deterministically (no fill fabricated, no reservation
   * auto-released where a positive external execution may exist):
   *   - portfolio settlement recorded but the intent status is not yet the
   *     matching ACCOUNTED_* state (crash after portfolio write, before intent
   *     write) => intent finalized to that ACCOUNTED state (from the settlement's
   *     `settlementMode`).
   *   - a terminal NO-FILL intent (CANCELED/VOID, no positive fill evidence) that
   *     still holds an ACTIVE reservation => released exactly once.
   *
   * Detected + REPORTED only (never auto-repaired, fail closed; safeToTrade=false):
   *   - a reservation for an intent id that does not exist (orphan; the operator
   *     may already have executed it) => never auto-released.
   *   - a BUY intent that is not terminal but has no active reservation (crash
   *     after intent write, before reservation write) => cannot be reconstructed.
   *   - an ACCOUNTED_* intent with no recorded settlement => never accepted silently.
   *   - any RECONCILIATION_REQUIRED or AMBIGUOUS intent => stays reserved until
   *     the operator resolves it (never auto-settled, never auto-released).
   *   - a PENDING intent keeps its reservation (open/partial, may still fill).
   *   - a corrupt/unsupported intent store.
   */
  reconcile(): ManualReconcileReport {
    const issues: ManualReconcileIssue[] = [];
    const fixes: ManualReconcileIssue[] = [];
    const push = (type: string, intentId: string | null, severity: ManualReconcileIssue['severity'], detail: string, fixed = false): void => {
      const issue: ManualReconcileIssue = { type, intentId, severity, detail, fixed };
      issues.push(issue);
      if (fixed) fixes.push(issue);
    };

    let portfolio = this.deps.getPortfolio();
    let intents: Map<string, ManualTradeIntent>;
    try {
      intents = this.deps.intentStore.allIntents();
    } catch (err) {
      push(
        'CORRUPT_INTENT_STORE',
        null,
        'error',
        `the manual intent store could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { issues, fixesApplied: fixes, safeToTrade: false };
    }

    // Orphan reservations: a portfolio order-reservation whose intent id has no
    // intent in the store. This is the crash window "reservation persisted, crash
    // before intent persisted". The reservation may already have a real external
    // execution, so it is NEVER auto-released — reported for the operator.
    for (const reservationId of portfolio.orderReservationsView().keys()) {
      if (!intents.has(reservationId)) {
        push(
          'ORPHAN_RESERVATION',
          reservationId,
          'error',
          `portfolio holds an active reservation for ${reservationId} but no matching intent exists; the operator must reconcile it (never auto-released; external execution may exist)`,
        );
      }
    }

    for (const intent of intents.values()) {
      try {
        const settlement = portfolio.manualSettlement(intent.intentId);
        const reservation = portfolio.orderReservation(intent.intentId);

        if (settlement) {
          // The settlement's settlementMode is the authority for the ACCOUNTED
          // state; finalize the intent to match (crash-after-write repair, no
          // re-accounting, no fill fabricated).
          const expected = settlement.settlementMode === 'operator_attested'
            ? 'ACCOUNTED_WITH_OPERATOR_ATTESTATION'
            : 'ACCOUNTED_WITH_EXCHANGE_VALIDATION';
          if (intent.status !== expected) {
            this.deps.intentStore.save({ ...intent, status: expected });
            push(
              'SETTLEMENT_WITHOUT_STATUS',
              intent.intentId,
              'warning',
              `portfolio already recorded a manual settlement but the intent status was not yet ${expected}; ` +
                'status finalized to the matching ACCOUNTED state (no fill fabricated, no re-accounting)',
              true,
            );
          }
          continue;
        }

        // No settlement recorded.
        if (isAccountedStatus(intent.status)) {
          push(
            'INTENT_ACCOUNTED_WITHOUT_SETTLEMENT',
            intent.intentId,
            'error',
            `intent is ${intent.status} but no manual settlement is recorded in the portfolio; never accepted silently — operator must reconcile`,
          );
          continue;
        }

        if (intent.status === 'RECONCILIATION_REQUIRED') {
          // Consistent evidence but the accounting cannot be safely completed.
          // Reservation is retained (a positive external execution may exist).
          push(
            'RECONCILIATION_REQUIRED_INTENT',
            intent.intentId,
            'error',
            'intent is RECONCILIATION_REQUIRED; its reservation stays reserved pending an authoritative fee/evidence resolution ' +
              '(never auto-settled, never auto-released)',
          );
          continue;
        }

        if (intent.status === 'AMBIGUOUS') {
          // Contradictory evidence: blocking, reservation retained.
          push(
            'AMBIGUOUS_INTENT',
            intent.intentId,
            'error',
            'intent is AMBIGUOUS; its reservation stays reserved pending operator resolution (record authoritative evidence or reconcile)',
          );
          continue;
        }

        if (intent.status === 'CANCELED' || intent.status === 'VOID') {
          // Terminal + no positive fill evidence: an ACTIVE reservation is a leak
          // (crash after intent cancel, before portfolio release). Release once.
          if (reservation && reservation.status === 'ACTIVE' && !intent.evidence?.filledQuantity?.isPositive()) {
            portfolio = portfolio.releaseOrderReservation(intent.intentId);
            this.deps.savePortfolio(portfolio);
            push(
              'LEAKED_RESERVATION',
              intent.intentId,
              'warning',
              'terminal no-fill intent still holds an ACTIVE reservation; released exactly once (fail-safe, mirrors cancel)',
              true,
            );
          }
          continue;
        }

        // PENDING (order open/partial, may still fill), PROPOSED / CONFIRMED /
        // EVIDENCE_RECORDED — still in progress. A BUY must still hold its ACTIVE
        // reservation; a missing one is a crash window that cannot be reconstructed.
        if (intent.side === 'BUY' && intent.reservationCurrency !== null && intent.reservationAmount !== null) {
          if (!reservation || reservation.status !== 'ACTIVE') {
            push(
              'MISSING_BUY_RESERVATION',
              intent.intentId,
              'error',
              'a not-yet-terminal BUY intent is missing its active reservation (crash after intent write, before reservation write); ' +
                'cannot be reconstructed — fail closed',
            );
          }
        }
      } catch (err) {
        push(
          'RECONCILE_INTENT_FAILED',
          intent.intentId,
          'error',
          `failed to reconcile intent: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const safeToTrade = issues.every((i) => i.severity !== 'error');
    return { issues, fixesApplied: fixes, safeToTrade };
  }

  /**
   * Resolve the fee for settlement. Only an AUTHORITATIVE, quote-denominated fee
   * from the exchange read is accepted. A base-denominated fee or the absence of
   * an exchange fee fails closed (a modelled/operator fee is never authoritative).
   */
  private resolveAuthoritativeFee(authoritative: Order): { ok: true; fee: Money } | { ok: false; reason: string } {
    const fee = authoritative.fee;
    if (!fee || !fee.isPositive()) {
      return {
        ok: false,
        reason:
          'no authoritative quote-denominated fee from the exchange; manual settlement requires an ' +
          'exchange-confirmed/reconciled fee (a modelled or operator-reported fee is never used as authoritative)',
      };
    }
    if (authoritative.feeCurrency === 'quote') {
      return { ok: true, fee };
    }
    if (authoritative.feeCurrency === 'base') {
      return {
        ok: false,
        reason: `authoritative fee is base-denominated (${fee}) and cannot be safely converted to quote without exchanging a derived value; manual settlement failed closed`,
      };
    }
    // 'unknown' (and any future currency) is NEVER assumed to be quote. NDAX
    // GetOrderStatus does not expose a fee currency; the authoritative fee asset
    // must come from account trade records (`feeProductId` + product/instrument
    // metadata). Until that is resolved and reliably bound to the order, a fee of
    // unknown currency fails closed.
    return {
      ok: false,
      reason: `authoritative fee currency "${authoritative.feeCurrency}" is not authoritatively quote; ` +
        'manual settlement requires an exchange-confirmed quote fee (never assume quote from a raw NDAX amount)',
    };
  }

  // --- risk snapshot construction ---

  private buildRiskSnapshot(ctx: RiskContext, approval: RiskApproval, opts: ManualProposeOptions): ManualRiskSnapshot {
    const quote = ctx.symbol.split('/')[1] ?? 'CAD';
    const market = ctx.marketInfo;
    const taker = market?.feeInfo?.taker ?? 0;
    const fee = taker > 0 ? fractionOf(approval.estimatedNotional, taker) : Money.zero();
    const requiredBalance = approval.estimatedNotional.add(fee);
    return {
      symbol: ctx.symbol,
      side: approval.side,
      type: opts.limitPrice ? 'limit' : 'market',
      referencePrice: approval.price,
      estimatedNotional: approval.estimatedNotional,
      estimatedFee: fee,
      quoteCurrency: quote,
      requiredBalance,
      deployableQuoteAtProposal: ctx.deployableQuote ?? Money.zero(),
      portfolioValueAtProposal: ctx.portfolioValue ?? Money.zero(),
      peakPortfolioValueAtProposal: ctx.peakPortfolioValue ?? Money.zero(),
      portfolioExposureAtProposal: ctx.portfolioExposure ?? Money.zero(),
      currentPositionAtProposal: ctx.currentPosition ?? Money.zero(),
      openManagedPositionCountAtProposal: ctx.openManagedPositionCount ?? 0,
      appliedLimits: approval.appliedLimits,
      marketDataTimestampMs: ctx.marketDataTimestampMs,
      // marketDataObservedAtMs is a LOCAL audit field, not an exchange timestamp,
      // so a missing observation falls back to the proposal wall-clock (never an
      // exchange-time fabrication).
      marketDataObservedAtMs: ctx.marketDataObservedAtMs ?? this.now(),
      proposalTimeMs: this.now(),
    };
  }
}

export type { ManualRiskSnapshot };
