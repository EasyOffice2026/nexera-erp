import { describe, expect, it } from 'vitest';
import { createAccountSchema, isDebitNormal } from './accounts';

const base = {
  code: '1110',
  name: { en: 'Cash', ar: 'نقد' },
  type: 'ASSET',
  subtype: 'cash',
};

describe('accounts', () => {
  it('accepts a subtype of the type', () => {
    expect(createAccountSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a subtype of another type', () => {
    expect(createAccountSchema.safeParse({ ...base, subtype: 'sales' }).success).toBe(false);
  });

  it('knows the normal side', () => {
    expect(isDebitNormal('ASSET')).toBe(true);
    expect(isDebitNormal('REVENUE')).toBe(false);
  });
});
