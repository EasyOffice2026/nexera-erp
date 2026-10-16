import i18n, { type TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { formatAmount } from '../lib/format';

export const inputClass =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal focus:ring-2 focus:ring-slate-400 focus:outline-none';
export const buttonClass =
  'rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 focus:ring-2 focus:ring-slate-400 focus:outline-none disabled:opacity-60';
export const secondaryButtonClass =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60';
export const dangerButtonClass =
  'rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-60';
export const tableClass = 'w-full border-collapse text-sm';
export const thClass = 'border-b border-slate-200 px-3 py-2 text-start font-medium text-slate-600';
export const tdClass = 'border-b border-slate-100 px-3 py-2';
export const numClass = 'border-b border-slate-100 px-3 py-2 text-end tabular-nums';

export function Field({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block text-sm font-medium text-slate-700 ${className}`}>
      {label}
      {children}
    </label>
  );
}

export function errorMessage(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    const key = `errors.${error.code}`;
    return i18n.exists(key) ? t(key as 'errors.unknown') : error.message;
  }
  // fetch() rejects with a TypeError when the server cannot be reached.
  const unreachable =
    error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
  return t(unreachable ? 'errors.network' : 'errors.unknown');
}

export function ErrorText({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
      {errorMessage(error, t)}
    </p>
  );
}

export function Loading() {
  const { t } = useTranslation();
  return <p className="p-4 text-sm text-slate-500">{t('common.loading')}</p>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl bg-white p-4 shadow-sm ${className}`}>{children}</section>;
}

// Amounts read left to right in both languages.
export function Amount({ value }: { value: string }) {
  return (
    <span dir="ltr" className="tabular-nums" data-amount={value}>
      {formatAmount(value)}
    </span>
  );
}
