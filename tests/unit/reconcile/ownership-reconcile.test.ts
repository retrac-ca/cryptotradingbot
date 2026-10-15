import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { reconcileBalances } from '../../../src/reconcile/index.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import type { Balance } from '../../../src/types.js';

const SYMBOL = 'BTC/CAD';

function bal(currency: string, amount: string): Balance {
  return { currency, total: Money.fromString(amount), available: Money.fromString(amount), held: Money.zero() };
}

function port(managedBtc: string, externalBtc: string, cad: string): Portfolio {
  let p = Portfolio.empty(new Map([['CAD', Money.fromString(cad)]]));
  if (Money.fromString(managedBtc).isPositive()) {
    p = p.applyFill(SYMBOL, 'BUY', Money.fromString(managedBtc), Money.fromString('40000'), Money.zero());
  }
  if (Money.fromString(externalBtc).isPositive()) {
    p = p.withExternalSnapshot(new Map([[SYMBOL, Money.fromString(externalBtc)]]));
  }
  return p;
}

/**
 * Ownership-aware reconciliation, now expressed against the single V1 balance
 * reconciler (`reconcileBalances`). The exchange balance is EVIDENCE, never
 * sufficient proof of BOT ownership: reconciliation DETECTS, it never adopts.
 */
describe('Ownership-aware reconciliation (V1 balance reconciliation)', () => {
  it('is consistent when the exchange matches the expected managed+external balances', () => {
    const findings = reconcileBalances(new Map([['BTC', Money.fromString('0.25')]]), [bal('BTC', '0.25')]);
    expect(findings).toHaveLength(0);
  });

  it('flags an unexpected deposit/manual buy (fail-safe, never adopted)', () => {
    // Exchange shows 0.30 BTC but the bot accounts for 0.25 -> unexplained gain.
    const findings = reconcileBalances(new Map([['BTC', Money.fromString('0.25')]]), [bal('BTC', '0.30')]);
    expect(findings.some((f) => f.currency === 'BTC' && f.mismatch)).toBe(true);
  });

  it('flags an unexplained withdrawal/manual sell', () => {
    // Exchange shows 0.20 BTC but the bot accounts for 0.25 -> unexplained loss.
    const findings = reconcileBalances(new Map([['BTC', Money.fromString('0.25')]]), [bal('BTC', '0.20')]);
    expect(findings.some((f) => f.currency === 'BTC' && f.mismatch)).toBe(true);
  });

  it('surfaces unexpected exchange inventory the bot does not expect, never auto-adopted', () => {
    // V1 surfaces an unexpected currency (a V0 observability gap this unification closes).
    const findings = reconcileBalances(new Map([['BTC', Money.fromString('0.25')]]), [
      bal('BTC', '0.25'),
      bal('CAD', '1000'),
    ]);
    expect(findings.some((f) => f.currency === 'CAD' && f.observed !== null)).toBe(true);
  });

  it('derives expected balances from the managed portfolio (managed + external by base)', () => {
    const p = port('0.1', '0.15', '1000');
    const expected = p.expectedAssetBalances();
    expect(expected.get('BTC')!.toFixed(8)).toBe('0.25000000');
    expect(expected.has('CAD')).toBe(false);
  });

  it('does not adopt unexpected crypto: reconciliation never mutates the portfolio', () => {
    const p = port('0.1', '0.0', '1000');
    const before = p.position(SYMBOL)!.quantity.toFixed(8);
    reconcileBalances(p.expectedAssetBalances(), [bal('BTC', '0.30'), bal('CAD', '1000')]);
    expect(p.position(SYMBOL)!.quantity.toFixed(8)).toBe(before);
    expect(p.external(SYMBOL).isZero()).toBe(true);
  });
});
