import { AMOUNT_PATTERN, type LocalizedName, toFils } from '@nexera/shared';

// Amounts come from the API as exact decimal strings ("1234.500"); they are never turned into
// floating-point numbers.
export function formatAmount(amount: string): string {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${fraction.padEnd(3, '0')}`;
}

// Fils of what someone typed, or 0 while it is not a valid amount yet.
export function filsOrZero(amount: string): bigint {
  const value = amount.trim();
  return AMOUNT_PATTERN.test(value) ? toFils(value) : 0n;
}

export function nameIn(name: LocalizedName, language: string): string {
  return (language === 'ar' ? name.ar : name.en) || name.en;
}

// Today in the browser's own time zone, as YYYY-MM-DD.
export function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
