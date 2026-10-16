import { describe, expect, it } from 'vitest';
import { journalLineSchema } from './journals';

const accountId = '0190a1b2-0000-7000-8000-000000000001';

describe('journal lines', () => {
  it('takes a debit or a credit', () => {
    expect(journalLineSchema.safeParse({ accountId, debit: '10' }).success).toBe(true);
    expect(journalLineSchema.safeParse({ accountId, credit: '10' }).success).toBe(true);
  });

  it('refuses both or neither', () => {
    expect(journalLineSchema.safeParse({ accountId, debit: '1', credit: '1' }).success).toBe(false);
    expect(journalLineSchema.safeParse({ accountId }).success).toBe(false);
  });
});
