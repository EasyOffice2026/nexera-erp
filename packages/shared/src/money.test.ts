import { describe, expect, it } from 'vitest';
import { fromFils, sumAmounts, toFils } from './money';

describe('money', () => {
  it('converts amounts to whole fils and back', () => {
    expect(toFils('12.5')).toBe(12500n);
    expect(toFils('0.001')).toBe(1n);
    expect(toFils('-3.250')).toBe(-3250n);
    expect(fromFils(12500n)).toBe('12.500');
    expect(fromFils(-1n)).toBe('-0.001');
  });

  it('adds exactly', () => {
    expect(sumAmounts(['0.1', '0.2', '0.003'])).toBe('0.303');
  });
});
