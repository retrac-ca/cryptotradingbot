import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { serializePortfolio, deserializePortfolio } from '../../../src/portfolio/serialization.js';

const SYMBOL = 'BTC/CAD';

function seeded(anchor?: Money): Portfolio {
  const p = Portfolio.empty(new Map([['CAD', Money.fromString('100000')]]));
  return p.applyFill(
    SYMBOL,
    'BUY',
    Money.fromString('0.1'),
    Money.fromString('50000'),
    Money.zero(),
    undefined,
    anchor,
  );
}

describe('entry anchor serialization', () => {
  it('round-trips a non-null anchor exactly', () => {
    const anchor = Money.fromString('49000.12345678');
    const json = serializePortfolio(seeded(anchor).stateModel);
    expect(json.positions[SYMBOL]!.entryAnchorPrice).toBe('49000.12345678');

    const restored = Portfolio.fromModel(deserializePortfolio(json));
    expect(restored.position(SYMBOL)!.entryAnchorPrice!.equals(anchor)).toBe(true);
  });

  it('omits the field entirely when the anchor is null', () => {
    const json = serializePortfolio(seeded().stateModel);
    expect('entryAnchorPrice' in json.positions[SYMBOL]!).toBe(false);
  });

  it('loads a legacy position JSON without the field as null', () => {
    const json = serializePortfolio(seeded().stateModel);
    delete json.positions[SYMBOL]!.entryAnchorPrice;
    const model = deserializePortfolio(json);
    expect(model.positions.get(SYMBOL)!.entryAnchorPrice).toBeNull();
  });

  it('fails closed on a malformed stored anchor', () => {
    const json = serializePortfolio(seeded().stateModel);
    (json.positions[SYMBOL] as { entryAnchorPrice?: string }).entryAnchorPrice = 'not-a-number';
    expect(() => deserializePortfolio(json)).toThrow();
  });

  it('fails closed on a non-positive stored anchor', () => {
    for (const bad of ['0', '-5', '0.00000000']) {
      const json = serializePortfolio(seeded().stateModel);
      (json.positions[SYMBOL] as { entryAnchorPrice?: string }).entryAnchorPrice = bad;
      expect(() => deserializePortfolio(json)).toThrow(/entry anchor/);
    }
  });
});
