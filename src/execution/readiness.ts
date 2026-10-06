/**
 * Controlled-LIVE BUY readiness model (redesigned).
 *
 * This is a READ-ONLY, pure evaluator. It never submits, cancels, or mutates any
 * state. It answers one question:
 *
 *   "Can THIS specific `bot live-test buy` invocation safely cross the
 *    controlled-live placement boundary?"
 *
 * WHY THIS EXISTS
 * ---------------
 * The original Gate 7.4 model treated every readiness property homogeneously and
 * fail-closed on ALL of them. Three of those properties are FUNDAMENTALLY
 * UNPROVABLE with the NDAX API (deterministic lost-ack re-attachment, a
 * universally-unique execution identity, and complete per-order execution
 * enumeration), so the gate was permanently NOT_READY. That did not add safety —
 * it made the controlled BUY path unreachable while claiming a guarantee NDAX
 * does not offer.
 *
 * The redesign separates properties by the kind of evidence that can establish
 * them, so the gate blocks only on genuinely required conditions and handles the
 * NDAX limitations with explicit, tested COMPENSATING CONTROLS instead of
 * fabricated guarantees.
 *
 * CATEGORIES
 * ----------
 *  - STRUCTURAL_GUARANTEE   Established by CONSTRUCTION / enforcement in the
 *                           controlled path, NOT observed at runtime by this
 *                           evaluator. The evaluator records the assertion; the
 *                           guarantee itself lives at the authorization / engine /
 *                           adapter boundary (`ControlledLiveAuthorization`,
 *                           `isControlledLiveOrder`, `NdaxAdapter.placeOrder`,
 *                           `LiveOrderEngine.assertGate`). Conditions here carry
 *                           `basis: 'STRUCTURAL_GUARANTEE'` and must never be read
 *                           as "this process observed the property live".
 *  - READ_ONLY_VERIFIABLE   Must be true immediately before submission and CAN be
 *                           observed read-only (mode, funds-at-risk, kill switch,
 *                           freshness, reconciliation, current order conflict,
 *                           managed CAD, risk/quantity/price/fee validity).
 *                           Conditions here carry `basis: 'RUNTIME_OBSERVED'`.
 *  - REQUIRES_CONTROLLED_REAL_BUY
 *                           The empirical results of the FIRST real BUY. They are
 *                           PENDING until that BUY happens and NEVER block it.
 *  - FUNDAMENTALLY_UNPROVABLE
 *                           Impossible to prove with the documented NDAX API; each
 *                           is paired with a compensating control and NEVER blocks.
 *  - SAFETY_COMPENSATION    The active engine controls that stand in for the
 *                           unprovable guarantees. Enforced by the engine and
 *                           covered by dedicated tests (see
 *                           `tests/unit/execution/controlledLiveBuy.test.ts`,
 *                           `liveExecution.test.ts`, `liveSubmissionLock.test.ts`).
 *
 * FAIL-CLOSED: every BLOCKING condition must be strictly `true`; `null`/`undefined`
 * means "UNKNOWN — cannot be established" and blocks exactly like `false`.
 */

export type ReadinessCategory =
  | 'STRUCTURAL_GUARANTEE'
  | 'READ_ONLY_VERIFIABLE'
  | 'REQUIRES_CONTROLLED_REAL_BUY'
  | 'FUNDAMENTALLY_UNPROVABLE'
  | 'SAFETY_COMPENSATION';

/**
 * How a condition's value was established — the explicit distinction between
 * construction/enforcement guarantees and runtime observations.
 *
 * - `STRUCTURAL_GUARANTEE`: true by construction in the controlled path. This
 *   evaluator does not (and cannot) observe it at runtime; it records the
 *   guarantee asserted by {@link structuralPlacementGuarantees}, whose
 *   enforcement lives at the authorization/engine/adapter boundary.
 * - `RUNTIME_OBSERVED`: read here from actual state (config, snapshot, risk,
 *   reconciliation, durable ledger) immediately before submission.
 * - `INFORMATIONAL`: reported for auditability only; never blocks.
 */
export type ReadinessBasis =
  | 'STRUCTURAL_GUARANTEE'
  | 'RUNTIME_OBSERVED'
  | 'INFORMATIONAL';

export type ReadinessStatus =
  | 'PASS'
  | 'BLOCKED'
  | 'OBSERVED'
  | 'PENDING_FIRST_BUY'
  | 'COMPENSATED'
  | 'ACTIVE';

export interface ReadinessCondition {
  /** Stable id. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** The evidence category this condition belongs to. */
  category: ReadinessCategory;
  /**
   * How this condition's value was established. `STRUCTURAL_GUARANTEE`
   * conditions are true by construction and are NOT observed by this evaluator;
   * `RUNTIME_OBSERVED` conditions are read from actual state.
   */
  basis: ReadinessBasis;
  /** PASS/BLOCKED for blocking checks; the category status otherwise. */
  status: ReadinessStatus;
  /** True only for conditions whose failure blocks placement. */
  blocking: boolean;
  /** Whether the value was UNKNOWN (null/undefined) rather than known-false. */
  unknown: boolean;
  /** Human-readable detail. */
  detail: string;
}

export type ReadinessVerdict = 'READY' | 'NOT_READY';

export interface LiveBuyReadinessReport {
  verdict: ReadinessVerdict;
  /** Every evaluated condition, across all categories. */
  conditions: ReadinessCondition[];
  /** Ids of the BLOCKING conditions that did not pass (empty when READY). */
  blockers: string[];
  /** True only when every blocking condition passed. */
  liveBuyAllowed: boolean;
}

/**
 * The empirical results of the first controlled real BUY. Each is `null` until
 * that BUY occurs. These are informational ONLY: they never block the first BUY.
 */
export interface ControlledRealBuyEvidence {
  /** The first controlled real BUY+LIMIT was accepted by NDAX. */
  buyLimitAccepted: boolean | null;
  /** The first controlled real BUY returned an exchange OrderId. */
  buyExchangeOrderIdReturned: boolean | null;
  /** The first controlled real BUY order was observable through the exchange. */
  buyOrderObservable: boolean | null;
  /** The first controlled real BUY produced the expected quote hold/available behavior. */
  quoteHoldObserved: boolean | null;
  /** The first controlled real BUY lifecycle (fill/partial/cancel) was observed. */
  buyLifecycleObserved: boolean | null;
}

/** An unprovable NDAX property and the compensating control that covers it. */
export interface UnprovableProperty {
  id: string;
  label: string;
  category: 'FUNDAMENTALLY_UNPROVABLE';
  /** The id of the SAFETY_COMPENSATION control that stands in for this property. */
  compensatingControlId: string;
  detail: string;
}

/** An active engine control that compensates for an unprovable guarantee. */
export interface SafetyCompensation {
  id: string;
  label: string;
  category: 'SAFETY_COMPENSATION';
  detail: string;
}

/**
 * Pre-assessed facts about a would-be controlled live BUY. A value of `null`
 * means the fact is NOT established (unknown) and, for a blocking condition,
 * must block. There is intentionally NO `operatorConfirmed` field: operator
 * confirmation is the interactive EXECUTE stage that happens AFTER readiness and
 * after the exact order is displayed — it is never a pre-existing system fact.
 */
export interface LiveBuyReadinessInput {
  // --- STRUCTURAL_GUARANTEE: controlled placement ---
  // These are asserted by `structuralPlacementGuarantees` (PROVEN BY CONSTRUCTION).
  // They are NOT runtime observations; the enforcement lives in
  // `ControlledLiveAuthorization`, `isControlledLiveOrder`, `NdaxAdapter` and
  // `LiveOrderEngine.assertGate`. Only `structuralGeneralPlacementDisabled` and
  // `structuralCapsPositive` are additionally corroborated by a direct read
  // (of the adapter capability and of configuration) — the rest are guaranteed
  // by the controlled path's construction.
  /** A genuine controlled-live authorization can be minted by the controlled path. */
  structuralAuthorizationCapability: boolean | null;
  /** The authorization is side-scoped, and this invocation is BUY. */
  structuralSideScopedToBuy: boolean | null;
  /** The authorization is LIMIT-only. */
  structuralLimitOnly: boolean | null;
  /** The authorization is single-use at the exchange mutation boundary. */
  structuralSingleUse: boolean | null;
  /** The authorization exposure caps are configured and positive (also observed from config). */
  structuralCapsPositive: boolean | null;
  /**
   * The GENERAL adapter does NOT advertise autonomous placement (observed from
   * the adapter). For NDAX this MUST stay `false`; the controlled authorization is
   * the explicit, per-invocation exception. (`supportsOrderPlacement` is NEVER
   * flipped to true.)
   */
  structuralGeneralPlacementDisabled: boolean | null;
  /** The adapter honors the controlled authorization as its explicit exception. */
  structuralAdapterHonorsAuthorization: boolean | null;

  // --- READ_ONLY_VERIFIABLE ---
  /** TRADING_MODE === 'live'. */
  tradingModeIsLive: boolean | null;
  /** REAL_FUNDS_AT_RISK acknowledged. */
  realFundsAtRisk: boolean | null;
  /** Global/remote kill switch is inactive. */
  killSwitchInactive: boolean | null;
  /** Authenticated reads are enabled for this adapter. */
  authenticatedReadsEnabled: boolean | null;
  /** Authenticated reads were actually observed to work (snapshot + reconcile clean). */
  authenticatedReadVerified: boolean | null;
  /** Market/account snapshot is fresh (quote + transport). */
  snapshotFresh: boolean | null;
  /** Full managed-portfolio valuation is valid (no missing/stale position). */
  portfolioValuationValid: boolean | null;
  /** The action-aware reconciliation pre-trade gate allowed this BUY. */
  reconciliationGateAllowed: boolean | null;
  /** No unresolved live-prefixed order in the durable ledger. */
  noUnresolvedLiveOrder: boolean | null;
  /** No currently-actionable local/exchange order-ownership conflict. */
  currentExchangeOrderConflictClear: boolean | null;
  /** The RiskManager approved this exact BUY. */
  riskApproved: boolean | null;
  /** Order quantity positive, on the tick grid, >= minimum. */
  orderQuantityValid: boolean | null;
  /** Reference price present and positive. */
  referencePriceValid: boolean | null;
  /** Exchange available quote provably covers the order (before managed bounding). */
  exchangeQuoteSufficient: boolean | null;
  /** Managed deployable CAD (net of reservations, bounded by exchange) covers the order + fee. */
  managedCashSufficient: boolean | null;
  /** Estimated taker fee is covered by the managed reservation. */
  feeCovered: boolean | null;
}

interface ConditionDef {
  id: string;
  label: string;
}

const CONTROLLED_PLACEMENT_CONDITIONS: ConditionDef[] = [
  { id: 'structuralAuthorizationCapability', label: '[structural guarantee] a genuine controlled-live authorization can be minted by the controlled path' },
  { id: 'structuralSideScopedToBuy', label: '[structural guarantee] the controlled authorization is side-scoped (this invocation is BUY)' },
  { id: 'structuralLimitOnly', label: '[structural guarantee] the controlled authorization is LIMIT-only' },
  { id: 'structuralSingleUse', label: '[structural guarantee] the controlled authorization is single-use at the mutation boundary' },
  { id: 'structuralCapsPositive', label: '[observed from config] the controlled authorization caps are configured and positive' },
  { id: 'structuralGeneralPlacementDisabled', label: '[observed from adapter] the general adapter does NOT advertise autonomous order placement' },
  { id: 'structuralAdapterHonorsAuthorization', label: '[structural guarantee] the adapter honors the controlled authorization as its explicit exception' },
];

const READ_ONLY_VERIFIABLE_CONDITIONS: ConditionDef[] = [
  { id: 'tradingModeIsLive', label: 'trading mode is LIVE' },
  { id: 'realFundsAtRisk', label: 'REAL_FUNDS_AT_RISK is acknowledged' },
  { id: 'killSwitchInactive', label: 'kill switch is inactive' },
  { id: 'authenticatedReadsEnabled', label: 'authenticated reads are enabled' },
  { id: 'authenticatedReadVerified', label: 'authenticated reads were observed to work' },
  { id: 'snapshotFresh', label: 'market/account snapshot is fresh (quote + transport)' },
  { id: 'portfolioValuationValid', label: 'full managed-portfolio valuation is valid' },
  { id: 'reconciliationGateAllowed', label: 'action-aware reconciliation pre-trade gate allows this BUY' },
  { id: 'noUnresolvedLiveOrder', label: 'no unresolved live order in the durable ledger' },
  { id: 'currentExchangeOrderConflictClear', label: 'no currently-actionable order-ownership conflict' },
  { id: 'riskApproved', label: 'RiskManager approved this exact BUY' },
  { id: 'orderQuantityValid', label: 'order quantity is valid (tick grid, >= minimum)' },
  { id: 'referencePriceValid', label: 'reference price is present and positive' },
  { id: 'exchangeQuoteSufficient', label: 'exchange available quote covers the order' },
  { id: 'managedCashSufficient', label: 'managed deployable CAD covers the order + fee' },
  { id: 'feeCovered', label: 'estimated fee is covered by the managed reservation' },
];

const FIRST_BUY_EVIDENCE_DEFS: { id: keyof ControlledRealBuyEvidence; label: string }[] = [
  { id: 'buyLimitAccepted', label: 'the first controlled real BUY+LIMIT was accepted by NDAX' },
  { id: 'buyExchangeOrderIdReturned', label: 'the first controlled real BUY returned an exchange OrderId' },
  { id: 'buyOrderObservable', label: 'the first controlled real BUY order was observable through the exchange' },
  { id: 'quoteHoldObserved', label: 'the first controlled real BUY showed the expected quote hold/available behavior' },
  { id: 'buyLifecycleObserved', label: 'the first controlled real BUY lifecycle (fill/partial/cancel) was observed' },
];

/**
 * NDAX properties that are FUNDAMENTALLY UNPROVABLE with the documented API.
 * They NEVER block placement; each is covered by an explicit compensating
 * control. The ids here are reported for auditability and are matched against
 * {@link SAFETY_COMPENSATIONS}.
 */
export const FUNDAMENTALLY_UNPROVABLE_PROPERTIES: UnprovableProperty[] = [
  {
    id: 'deterministicLostAckReattachment',
    label: 'deterministic lost-ack re-attachment',
    category: 'FUNDAMENTALLY_UNPROVABLE',
    compensatingControlId: 'unknownDurableRetainsReservation',
    detail: 'NDAX ClientOrderId is documented as possibly non-unique and no provably-unique recovery key exists.',
  },
  {
    id: 'universalExecutionIdUniqueness',
    label: 'universally-unique execution id',
    category: 'FUNDAMENTALLY_UNPROVABLE',
    compensatingControlId: 'accountingFailClosedOperatorAttestationNonProven',
    detail: 'GetAccountTrades exposes an executionId, but universal uniqueness is not proven.',
  },
  {
    id: 'completePerOrderExecutionEnumeration',
    label: 'complete per-order execution enumeration',
    category: 'FUNDAMENTALLY_UNPROVABLE',
    compensatingControlId: 'accountingFailClosedOperatorAttestationNonProven',
    detail: 'Account trades are paginated and not reliably filterable by order, so completeness cannot be proven.',
  },
  {
    id: 'universalExactlyOnceAccounting',
    label: 'universal exactly-once accounting',
    category: 'FUNDAMENTALLY_UNPROVABLE',
    compensatingControlId: 'accountingFailClosedOperatorAttestationNonProven',
    detail: 'Exactly-once cannot be guaranteed when execution enumeration is incomplete; accounting stays fail-closed.',
  },
  {
    id: 'exchangeProvenProvenanceFromLostAck',
    label: 'exchange-proven provenance from a lost-ack order to a RETRAC intent',
    category: 'FUNDAMENTALLY_UNPROVABLE',
    compensatingControlId: 'noAutomaticReattachmentOperatorResolutionRequired',
    detail: 'There is no deterministic exchange-side link from an ambiguous submission to a specific local intent.',
  },
];

/**
 * The compensating controls that stand in for the unprovable guarantees. These
 * are enforced by the engine (not fabricated readiness): the report lists them as
 * ACTIVE, and dedicated tests fail if any is bypassed.
 */
export const SAFETY_COMPENSATIONS: SafetyCompensation[] = [
  {
    id: 'createdPersistedBeforeSubmit',
    label: 'local CREATED state is persisted before SendOrder',
    category: 'SAFETY_COMPENSATION',
    detail: 'persist-before-submit under the state-dir mutation lock (LiveOrderEngine.submit).',
  },
  {
    id: 'transactionalManagedReservation',
    label: 'managed CAD is reserved transactionally before SendOrder (fail-closed)',
    category: 'SAFETY_COMPENSATION',
    detail:
      'reservation is enforced transactionally, not preflight-projected: LiveOrderEngine.submit reloads fresh ' +
      'managed state under the mutation lock and Portfolio.reserveOrder refuses (throws) when the exact cost ' +
      'exceeds deployable; the reservation is persisted before exchange contact and retained on UNKNOWN. ' +
      'This is why readiness does NOT report a separate "no conflicting active reservation" observation.',
  },
  {
    id: 'ambiguousSubmissionBecomesUnknown',
    label: 'an ambiguous submission becomes UNKNOWN',
    category: 'SAFETY_COMPENSATION',
    detail: 'timeout/network/invalid/ambiguous results transition the order to UNKNOWN, never to FILLED.',
  },
  {
    id: 'unknownDurableRetainsReservation',
    label: 'UNKNOWN is durable and retains the managed reservation',
    category: 'SAFETY_COMPENSATION',
    detail: 'the UNKNOWN record is saved and the BUY managed-quote reservation is NOT released.',
  },
  {
    id: 'unknownBlocksFurtherPlacement',
    label: 'UNKNOWN blocks further live placement',
    category: 'SAFETY_COMPENSATION',
    detail: 'the one-in-flight guard treats CREATED/SUBMITTED/OPEN/PARTIALLY_FILLED/UNKNOWN as blocking.',
  },
  {
    id: 'noRetryNoRepriceNoHeuristicMatching',
    label: 'no retry, no repricing, no heuristic order matching',
    category: 'SAFETY_COMPENSATION',
    detail: 'an ambiguous outcome is never resent, repriced, or matched heuristically to another order.',
  },
  {
    id: 'noOpenOrdersAbsenceInference',
    label: 'absence from OpenOrders is never treated as proof the order never existed',
    category: 'SAFETY_COMPENSATION',
    detail: 'a zero-match recovery is not proof of rejection; the order remains UNKNOWN.',
  },
  {
    id: 'noAutomaticReattachmentOperatorResolutionRequired',
    label: 'no automatic re-attachment; operator resolution is required',
    category: 'SAFETY_COMPENSATION',
    detail: 'only a provable unique match may re-attach; otherwise an operator resolves the order.',
  },
  {
    id: 'accountingFailClosedOperatorAttestationNonProven',
    label: 'accounting stays fail-closed; operator attestation is explicitly non-proven',
    category: 'SAFETY_COMPENSATION',
    detail: 'only PROVEN correlations with a valid QUOTE fee are auto-accounted; attestations remain provenanceProof=false.',
  },
];

function evaluateBlocking(
  input: LiveBuyReadinessInput,
  defs: ConditionDef[],
  category: ReadinessCategory,
  basis: ReadinessBasis,
): { conditions: ReadinessCondition[]; blockers: string[] } {
  const conditions: ReadinessCondition[] = [];
  const blockers: string[] = [];
  const raw = input as unknown as Record<string, unknown>;
  for (const d of defs) {
    const value = raw[d.id];
    const status: ReadinessStatus = value === true ? 'PASS' : 'BLOCKED';
    const unknown = value === null || value === undefined;
    if (status !== 'PASS') blockers.push(d.id);
    conditions.push({
      id: d.id,
      label: d.label,
      category,
      basis,
      status,
      blocking: true,
      unknown,
      detail:
        status === 'PASS'
          ? basis === 'STRUCTURAL_GUARANTEE'
            ? 'guaranteed by construction (enforced at the authorization/engine/adapter boundary)'
            : 'verified/passed'
          : unknown
            ? 'UNKNOWN — not established'
            : 'not satisfied',
    });
  }
  return { conditions, blockers };
}

/**
 * Evaluate the controlled-live BUY readiness. Only the STRUCTURAL_GUARANTEE and
 * READ_ONLY_VERIFIABLE conditions block. The empirical first-BUY evidence, the
 * fundamentally-unprovable properties, and the compensating controls are always
 * reported but NEVER block.
 *
 * @param input the pre-assessed blocking facts
 * @param evidence optional first-controlled-BUY observations (null until observed)
 */
export function evaluateLiveBuyReadiness(
  input: LiveBuyReadinessInput,
  evidence: ControlledRealBuyEvidence | null = null,
): LiveBuyReadinessReport {
  const placement = evaluateBlocking(
    input,
    CONTROLLED_PLACEMENT_CONDITIONS,
    'STRUCTURAL_GUARANTEE',
    'STRUCTURAL_GUARANTEE',
  );
  const readOnly = evaluateBlocking(
    input,
    READ_ONLY_VERIFIABLE_CONDITIONS,
    'READ_ONLY_VERIFIABLE',
    'RUNTIME_OBSERVED',
  );

  const conditions: ReadinessCondition[] = [...placement.conditions, ...readOnly.conditions];
  const blockers: string[] = [...placement.blockers, ...readOnly.blockers];

  // REQUIRES CONTROLLED REAL BUY: informational only.
  const ev = evidence as unknown as Record<string, unknown> | null;
  for (const d of FIRST_BUY_EVIDENCE_DEFS) {
    const observed = ev !== null && ev[d.id] === true;
    conditions.push({
      id: d.id,
      label: d.label,
      category: 'REQUIRES_CONTROLLED_REAL_BUY',
      basis: 'INFORMATIONAL',
      status: observed ? 'OBSERVED' : 'PENDING_FIRST_BUY',
      blocking: false,
      unknown: !observed,
      detail: observed
        ? 'observed in a controlled real BUY'
        : 'not yet established — the first controlled real BUY is the empirical test; this never blocks placement',
    });
  }

  // FUNDAMENTALLY UNPROVABLE: informational + compensated.
  for (const u of FUNDAMENTALLY_UNPROVABLE_PROPERTIES) {
    conditions.push({
      id: u.id,
      label: u.label,
      category: 'FUNDAMENTALLY_UNPROVABLE',
      basis: 'INFORMATIONAL',
      status: 'COMPENSATED',
      blocking: false,
      unknown: true,
      detail: `${u.detail} Compensated by control "${u.compensatingControlId}" (not provable with the NDAX API).`,
    });
  }

  // SAFETY COMPENSATION: the active controls standing in for the unprovable ones.
  for (const c of SAFETY_COMPENSATIONS) {
    conditions.push({
      id: c.id,
      label: c.label,
      category: 'SAFETY_COMPENSATION',
      basis: 'INFORMATIONAL',
      status: 'ACTIVE',
      blocking: false,
      unknown: false,
      detail: c.detail,
    });
  }

  const ready = blockers.length === 0;
  return {
    verdict: ready ? 'READY' : 'NOT_READY',
    conditions,
    blockers,
    liveBuyAllowed: ready,
  };
}

/** The minimal adapter surface used to derive structural placement guarantees. */
export interface StructuralPlacementAdapter {
  id: string;
  capabilities: { supportsOrderPlacement: boolean };
}

/**
 * The STRUCTURAL PLACEMENT GUARANTEES of the controlled path.
 *
 * IMPORTANT — these are NOT runtime observations. They are true by CONSTRUCTION
 * and are asserted here so the readiness report can present them honestly as
 * `basis: 'STRUCTURAL_GUARANTEE'`. The actual enforcement lives at:
 *   - `ControlledLiveAuthorization` — side binding, LIMIT-only, positive caps,
 *     anti-forgery scope binding, single-use token consumption;
 *   - `isControlledLiveOrder` — the adapter-boundary check (side == scope side,
 *     LIMIT, within caps) that consumes the token;
 *   - `NdaxAdapter.placeOrder` / `assertOrderPlacementEnabled` — the controlled
 *     authorization is the ONLY exception (besides the internal test switch that
 *     is never set via config);
 *   - `LiveOrderEngine.assertGate` — requires a genuine controlled authorization.
 *
 * Two of the returned values are additionally CORROBORATED by a direct read:
 *   - `structuralGeneralPlacementDisabled` is observed from
 *     `adapter.capabilities.supportsOrderPlacement` (must be `false`).
 *   - `structuralCapsPositive` is observed from configuration.
 * The remaining values are guaranteed by the construction of the controlled path.
 *
 * No live authorization is minted here: readiness runs BEFORE minting, preserving
 * the ordering readiness -> mint -> prepare -> display -> EXECUTE -> submit.
 */
export function structuralPlacementGuarantees(
  adapter: StructuralPlacementAdapter,
  cfg: { liveMaxBaseQuantity: number; liveMaxQuoteNotional: number },
): Pick<
  LiveBuyReadinessInput,
  | 'structuralAuthorizationCapability'
  | 'structuralSideScopedToBuy'
  | 'structuralLimitOnly'
  | 'structuralSingleUse'
  | 'structuralCapsPositive'
  | 'structuralGeneralPlacementDisabled'
  | 'structuralAdapterHonorsAuthorization'
> {
  return {
    structuralAuthorizationCapability: true,
    structuralSideScopedToBuy: true,
    structuralLimitOnly: true,
    structuralSingleUse: true,
    structuralCapsPositive: cfg.liveMaxBaseQuantity > 0 && cfg.liveMaxQuoteNotional > 0,
    structuralGeneralPlacementDisabled: adapter.capabilities.supportsOrderPlacement === false,
    // The controlled path only ever reaches the adapter through the controlled
    // authorization boundary (NdaxAdapter.placeOrder -> isControlledLiveOrder).
    structuralAdapterHonorsAuthorization: true,
  };
}
