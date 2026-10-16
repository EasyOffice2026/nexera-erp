import { describe, expect, it } from 'vitest';
import { applyMapping, guessMapping, parseAmount, parseStatementDate } from './bank';

describe('parseAmount', () => {
  it.each([
    ['1,234.500', 1_234_500n],
    ['(12.5)', -12_500n],
    ['12.500-', -12_500n],
    ['-0.250', -250n],
    ['12.500 DR', -12_500n],
    ['12.500 CR', 12_500n],
    ['KWD 7', 7_000n],
    ['١٬٢٣٤٫٥٠٠', 1_234_500n],
    ['12.5000', 12_500n],
  ])('reads %s', (text, fils) => {
    expect(parseAmount(text)).toBe(fils);
  });

  it.each(['', 'abc', '12.5001', '1.2.3'])('rejects "%s"', (text) => {
    expect(parseAmount(text)).toBeNull();
  });
});

describe('parseStatementDate', () => {
  it.each([
    ['2026-03-05', 'DMY', '2026-03-05'],
    ['2026-03-05T00:00:00.000Z', 'DMY', '2026-03-05'],
    ['05/03/2026', 'DMY', '2026-03-05'],
    ['05/03/2026', 'MDY', '2026-05-03'],
    ['5-3-26', 'DMY', '2026-03-05'],
    ['05.03.2026 10:22', 'DMY', '2026-03-05'],
    ['05-Mar-2026', 'DMY', '2026-03-05'],
    ['05 مارس 2026', 'DMY', '2026-03-05'],
    ['٠٥/٠٣/٢٠٢٦', 'DMY', '2026-03-05'],
    ['46086', 'DMY', '2026-03-05'],
  ] as const)('reads %s (%s)', (text, order, iso) => {
    expect(parseStatementDate(text, order)).toBe(iso);
  });

  it.each(['31/02/2026', 'Opening balance', '12345', ''])('rejects "%s"', (text) => {
    expect(parseStatementDate(text, 'DMY')).toBeNull();
  });
});

describe('statement mapping', () => {
  const english = [
    ['National Bank of Kuwait', '', '', '', ''],
    ['Account statement', '', '', '', ''],
    ['Transaction Date', 'Description', 'Debit', 'Credit', 'Balance'],
    ['', 'Opening balance', '', '', '1,000.000'],
    ['01/03/2026', 'KNET SETTLEMENT 0301', '', '250.500', '1,250.500'],
    ['02/03/2026', 'BANK CHARGES', '1.250', '', '1,249.250'],
    ['', '', '', '', ''],
    ['', 'Closing balance', '', '', '1,249.250'],
  ];

  it('finds headings and reads debit and credit columns', () => {
    const mapping = guessMapping(english);
    expect(mapping).toMatchObject({
      headerRow: 2,
      date: 0,
      description: 1,
      amountMode: 'split',
      moneyOut: 2,
      moneyIn: 3,
      balance: 4,
    });
    const result = applyMapping(english, mapping!);
    expect(result.lines).toEqual([
      {
        row: 5,
        date: '2026-03-01',
        description: 'KNET SETTLEMENT 0301',
        reference: '',
        amount: '250.500',
        balance: '1250.500',
      },
      {
        row: 6,
        date: '2026-03-02',
        description: 'BANK CHARGES',
        reference: '',
        amount: '-1.250',
        balance: '1249.250',
      },
    ]);
    expect(result.skipped).toEqual([
      { row: 4, reason: 'NO_DATE' },
      { row: 8, reason: 'NO_DATE' },
    ]);
  });

  it('reads Arabic headings with one signed amount column', () => {
    const arabic = [
      ['التاريخ', 'البيان', 'المرجع', 'المبلغ', 'الرصيد'],
      ['2026-03-01', 'إيداع نقدي', 'D-1', '500', '500'],
      ['2026-03-04', 'شيك', 'CHQ-9', '-120.750', '379.250'],
    ];
    const mapping = guessMapping(arabic);
    expect(mapping).toMatchObject({
      headerRow: 0,
      date: 0,
      description: 1,
      reference: 2,
      amountMode: 'signed',
      amount: 3,
      balance: 4,
    });
    const { lines } = applyMapping(arabic, mapping!);
    expect(lines.map((line) => [line.reference, line.amount])).toEqual([
      ['D-1', '500.000'],
      ['CHQ-9', '-120.750'],
    ]);
    expect(applyMapping(arabic, { ...mapping!, negate: true }).lines[1]?.amount).toBe('120.750');
  });
});
