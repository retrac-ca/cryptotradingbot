import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';

const B = 'BTC/CAD';
const E = 'ETH/CAD';

function base(over: Partial<Record<string, string>> = {}): Portfolio {
  const cash = new Map<string, Money>();
  cash.set('CAD', Money.fromString(over.cad ?? '1000'));
  if (over.btc) cash.set('BTC', Money.fromString(over.btc));
  return Portfolio.empty(cash);
}

describe('Portfolio — external vs bot-managed ownership', () => {
  it('records external holdings at onboarding; they are not managed positions', () => {
    const p = base().withExternalSnapshot(new Map([[B, Money.fromString('0.00034411')]]));
    expect(p.position(B)).toBeNull();
    expect(p.external(B).toFixed(8)).toBe('0.00034411');
    expect(p.managedOpenCount()).toBe(0);
    // External inventory does not count toward managed exposure/equity.
    expect(p.exposure(new Map([[B, Money.fromString('40000')]])).isZero()).toBe(true);
  });

  it('does not sell external inventory: managed position is separate', () => {
    const p = base().withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]));
    // No managed position => managedOpenCount 0; the bot has nothing to sell.
    expect(p.position(B)).toBeNull();
    expect(p.managedOpenCount()).toBe(0);
  });

  it('authorizeExternal converts an external asset into a managed EXTERNAL_AUTHORIZED position', () => {
    const p = base().withExternalSnapshot(new Map([[B, Money.fromString('0.5')]]));
    const p2 = p.authorizeExternal(B);
    expect(p2.external(B).isZero()).toBe(true);
    expect(p2.isAuthorizedExternal(B)).toBe(true);
    const pos = p2.position(B)!;
    expect(pos.quantity.toFixed(8)).toBe('0.50000000');
    expect(pos.source).toBe('EXTERNAL_AUTHORIZED');
    expect(p2.managedOpenCount()).toBe(1);
  });

  it('unauthorized external asset remains protected (not authorized)', () => {
    const p = base().withExternalSnapshot(new Map([[B, Money.fromString('0.5')]]));
    expect(p.isAuthorizedExternal(B)).toBe(false);
    expect(p.position(B)).toBeNull();
  });

  it('authorizeExternal throws when there is no external inventory', () => {
    const p = base();
    expect(() => p.authorizeExternal(B)).toThrow(/no external inventory/);
  });

  it('managed position origin is BOT by default and preserved when scaled', () => {
    let p = base().applyFill(B, 'BUY', Money.fromString('0.5'), Money.fromString('1000'), Money.fromString('1'));
    expect(p.position(B)!.source).toBe('BOT');
    p = p.applyFill(B, 'BUY', Money.fromString('0.5'), Money.fromString('1000'), Money.fromString('1'));
    expect(p.position(B)!.source).toBe('BOT');
  });

  it('managedOpenCount counts only managed (not external) positions', () => {
    let p = base()
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')], [E, Money.fromString('2')]]))
      .applyFill(E, 'BUY', Money.fromString('0.1'), Money.fromString('3000'), Money.fromString('1'));
    // Only the bot-created ETH counts; BTC external does not.
    expect(p.managedOpenCount()).toBe(1);
    // maxOpenPositions=1 is reached by the managed ETH position.
    expect(p.atMaxOpenPositions(1)).toBe(true);
    expect(p.atMaxOpenPositions(0)).toBe(false);
  });

  it('deployableQuote = available cash minus reserved quote (never negative)', () => {
    let p = base();
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('1000.00');
    p = p.reserveQuote('CAD', Money.fromString('300'));
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('700.00');
    // Reserve up to the deployable pool -> deployable clamps to zero, never negative.
    p = p.reserveQuote('CAD', Money.fromString('700'));
    expect(p.reserved('CAD').toFixed(2)).toBe('1000.00');
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('0.00');
    // Releasing part of the reservation restores exactly that much deployable.
    p = p.releaseQuote('CAD', Money.fromString('400'));
    expect(p.reserved('CAD').toFixed(2)).toBe('600.00');
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('400.00');
  });

  it('cannot reserve more than the deployable pool (fail closed, F-9)', () => {
    const p = base(); // cash 1000
    expect(() => p.reserveQuote('CAD', Money.fromString('1500'))).toThrow(/exceeds deployable quote/);
  });

  it('expectedAssetBalances sums managed + external per BASE asset (not per symbol)', () => {
    const p = base()
      .withExternalSnapshot(new Map([[B, Money.fromString('0.2475')]]))
      .applyFill(B, 'BUY', Money.fromString('0.0025'), Money.fromString('40000'), Money.fromString('5'))
      .withExternalSnapshot(new Map([[B, Money.fromString('0.2475')]]));
    const expected = p.expectedAssetBalances();
    expect(expected.get('BTC')!.toFixed(8)).toBe('0.25000000');
    // Quote (CAD) is deliberately excluded from asset expectations.
    expect(expected.has('CAD')).toBe(false);
  });

  it('exposure and markToMarket operate only on managed positions', () => {
    const p = base()
      .withExternalSnapshot(new Map([[B, Money.fromString('0.5')]]))
      .applyFill(E, 'BUY', Money.fromString('0.1'), Money.fromString('3000'), Money.fromString('1'));
    const prices = new Map<string, Money>([
      [B, Money.fromString('40000')],
      [E, Money.fromString('3100')],
    ]);
    const mtm = p.markToMarket(prices);
    // Equity = cash + managed ETH market value only (external BTC excluded).
    const cashAfter = Money.fromString('1000').sub(Money.fromString('301'));
    expect(mtm.equity.toFixed(2)).toBe(cashAfter.add(Money.fromString('310')).toFixed(2));
    expect(p.exposure(prices).toFixed(2)).toBe('310.00');
  });
});
