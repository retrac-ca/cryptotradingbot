/**
 * Balance reconciliation (Reconciliation V1).
 *
 * Compares the bot's expected LOCAL managed balances against the exchange's
 * authoritative balances. It NEVER adopts unexpected exchange inventory as
 * BOT-owned; an unexplained difference is a discrepancy (operator). The default
 * tolerance is one smallest representable Money unit (deterministic precision),
 * never an arbitrary float tolerance.
 */

import { Money } from '../money/Money.js';
import type { Balance } from '../types.js';
import type { BalanceFinding } from './reconciliationTypes.js';

const DEFAULT_TOLERANCE = Money.fromString('0.00000001');

export function reconcileBalances(
  expected: Map<string, Money>,
  observed: Balance[],
  tolerance: Money = DEFAULT_TOLERANCE,
): BalanceFinding[] {
  const findings: BalanceFinding[] = [];
  const observedByCurrency = new Map(observed.map((b) => [b.currency, b]));

  // 1) Every currency the bot expects must exist and match within tolerance.
  for (const [currency, expectedAvailable] of expected) {
    const exchange = observedByCurrency.get(currency);
    if (!exchange) {
      findings.push({
        currency,
        expected: expectedAvailable,
        observed: null,
        mismatch: true,
        reason: `expected local ${currency} balance but exchange reports none`,
      });
      continue;
    }
    // available = total - held (NDAX). Do not double-subtract held.
    const diff = expectedAvailable.sub(exchange.available);
    const abs = diff.isNegative() ? diff.negate() : diff;
    if (abs.compareTo(tolerance) > 0) {
      findings.push({
        currency,
        expected: expectedAvailable,
        observed: exchange.available,
        mismatch: true,
        reason: `local ${currency} available ${expectedAvailable.toString()} != exchange ${exchange.available.toString()} (diff ${abs.toString()} > tol ${tolerance.toString()})`,
      });
    }
  }

  // 2) Unexpected exchange inventory is a finding but NEVER auto-adopted as BOT.
  for (const b of observed) {
    if (!expected.has(b.currency) && b.total.isPositive()) {
      findings.push({
        currency: b.currency,
        expected: null,
        observed: b.total,
        mismatch: true,
        reason: `exchange reports ${b.currency} not accounted for by the bot; NOT auto-adopted as BOT-owned`,
      });
    }
  }

  return findings;
}
