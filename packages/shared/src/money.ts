import { z } from 'zod';

// Amounts travel as strings with up to 3 decimals (Kuwaiti fils), for example "12.500".
// Arithmetic is done in whole fils (bigint) so totals are exact.
export const AMOUNT_PATTERN = /^\d{1,15}(\.\d{1,3})?$/;

export const amountSchema = z
  .string()
  .trim()
  .regex(AMOUNT_PATTERN, 'Must be an amount with up to 3 decimals');

export function toFils(amount: string): bigint {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  const fils = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3) || '0');
  return negative ? -fils : fils;
}

export function fromFils(fils: bigint): string {
  const negative = fils < 0n;
  const abs = negative ? -fils : fils;
  const text = `${abs / 1000n}.${(abs % 1000n).toString().padStart(3, '0')}`;
  return negative ? `-${text}` : text;
}

export function sumAmounts(amounts: readonly string[]): string {
  return fromFils(amounts.reduce((total, amount) => total + toFils(amount), 0n));
}
