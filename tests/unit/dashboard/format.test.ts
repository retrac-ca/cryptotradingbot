import { describe, it, expect } from 'vitest';
import {
  EMPTY,
  displayMoney,
  displayText,
  escapeHtml,
  formatTimestamp,
  groupDecimal,
} from '../../../web/src/format.js';

describe('dashboard format helpers', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("it's & <ok>")).toBe('it&#39;s &amp; &lt;ok&gt;');
  });

  it('groups decimal strings exactly without floating point', () => {
    expect(groupDecimal('0.01000000')).toBe('0.01000000');
    expect(groupDecimal('1234567.89000000')).toBe('1,234,567.89000000');
    expect(groupDecimal('1000')).toBe('1,000');
    expect(groupDecimal('-1234.5')).toBe('-1,234.5');
    expect(groupDecimal('123456789012345678901234567890.1')).toBe(
      '123,456,789,012,345,678,901,234,567,890.1',
    );
  });

  it('leaves non-decimal strings untouched', () => {
    expect(groupDecimal('UNAVAILABLE')).toBe('UNAVAILABLE');
    expect(groupDecimal('')).toBe('');
  });

  it('renders missing money as an em dash, never zero', () => {
    expect(displayMoney(null)).toBe(EMPTY);
    expect(displayMoney(undefined)).toBe(EMPTY);
    expect(displayMoney('')).toBe(EMPTY);
    expect(displayMoney('0.00000000')).toBe('0.00000000');
  });

  it('renders missing text as an em dash', () => {
    expect(displayText(null)).toBe(EMPTY);
    expect(displayText('hello')).toBe('hello');
  });

  it('formats timestamps and missing timestamps safely', () => {
    expect(formatTimestamp(0)).toBe('1970-01-01 00:00:00.000 UTC');
    expect(formatTimestamp(null)).toBe(EMPTY);
    expect(formatTimestamp(Number.NaN)).toBe(EMPTY);
  });
});
