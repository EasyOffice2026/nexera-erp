import { type Account, type AccountType, accountSubtypes, accountTypes } from '@nexera/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccounts, useCompanyId, useName } from '../../app/company';
import {
  buttonClass,
  Card,
  dangerButtonClass,
  ErrorText,
  Field,
  inputClass,
  Loading,
  PageHeader,
  secondaryButtonClass,
  tableClass,
  tdClass,
  thClass,
} from '../../components/ui';
import { request } from '../../lib/api';
import { subtypeLabel } from '../../lib/subtype-labels';
import { useCan } from '../auth/auth-context';

interface TreeRow {
  account: Account;
  depth: number;
}

// Each account follows its parent, children in code order.
function asTree(accounts: readonly Account[]): TreeRow[] {
  const children = new Map<string | null, Account[]>();
  for (const account of accounts) {
    const siblings = children.get(account.parentId) ?? [];
    siblings.push(account);
    children.set(account.parentId, siblings);
  }
  const rows: TreeRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const list = [...(children.get(parentId) ?? [])].sort((a, b) => a.code.localeCompare(b.code));
    for (const account of list) {
      rows.push({ account, depth });
      visit(account.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

function NewAccountForm({
  companyId,
  accounts,
  onDone,
}: {
  companyId: string;
  accounts: readonly Account[];
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation();
  const name = useName();
  const queryClient = useQueryClient();
  const [type, setType] = useState<AccountType>('EXPENSE');
  const [form, setForm] = useState({
    code: '',
    en: '',
    ar: '',
    subtype: '',
    parentId: '',
    isPostable: true,
    taxonomyConcept: '',
  });
  const subtypes = accountSubtypes[type];
  const headers = accounts.filter((account) => account.type === type && !account.isPostable);

  const create = useMutation({
    mutationFn: () =>
      request<Account>(`/companies/${companyId}/accounts`, {
        method: 'POST',
        body: {
          code: form.code,
          name: { en: form.en, ar: form.ar },
          type,
          subtype: form.subtype || subtypes[0],
          parentId: form.parentId || null,
          isPostable: form.isPostable,
          taxonomyConcept: form.taxonomyConcept || null,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts', companyId] });
      onDone();
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <Card className="mb-4">
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3">
        <Field label={t('accounts.type')}>
          <select
            className={inputClass}
            value={type}
            onChange={(e) => {
              setType(e.target.value as AccountType);
              setForm({ ...form, subtype: '', parentId: '' });
            }}
          >
            {accountTypes.map((value) => (
              <option key={value} value={value}>
                {t(`accountTypes.${value}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('accounts.subtype')}>
          <select
            className={inputClass}
            value={form.subtype || subtypes[0]}
            onChange={(e) => setForm({ ...form, subtype: e.target.value })}
          >
            {subtypes.map((value) => (
              <option key={value} value={value}>
                {subtypeLabel(value, i18n.language)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('accounts.parent')}>
          <select
            className={inputClass}
            value={form.parentId}
            onChange={(e) => setForm({ ...form, parentId: e.target.value })}
          >
            <option value="">{t('accounts.noParent')}</option>
            {headers.map((header) => (
              <option key={header.id} value={header.id}>
                {header.code} · {name(header.name)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('common.code')}>
          <input
            required
            dir="ltr"
            inputMode="numeric"
            className={inputClass}
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
        </Field>
        <Field label={t('common.nameEn')}>
          <input
            required
            dir="ltr"
            className={inputClass}
            value={form.en}
            onChange={(e) => setForm({ ...form, en: e.target.value })}
          />
        </Field>
        <Field label={t('common.nameAr')}>
          <input
            required
            dir="rtl"
            className={inputClass}
            value={form.ar}
            onChange={(e) => setForm({ ...form, ar: e.target.value })}
          />
        </Field>
        <Field label={t('accounts.concept')}>
          <input
            dir="ltr"
            placeholder={t('accounts.conceptHint')}
            className={inputClass}
            value={form.taxonomyConcept}
            onChange={(e) => setForm({ ...form, taxonomyConcept: e.target.value })}
          />
        </Field>
        <label className="flex items-center gap-2 self-end text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.isPostable}
            onChange={(e) => setForm({ ...form, isPostable: e.target.checked })}
          />
          {t('accounts.postable')}
        </label>
        <div className="sm:col-span-3">
          <ErrorText error={create.error} />
        </div>
        <div>
          <button type="submit" className={buttonClass} disabled={create.isPending}>
            {t('common.create')}
          </button>
        </div>
      </form>
    </Card>
  );
}

export function AccountsPage() {
  const { t, i18n } = useTranslation();
  const companyId = useCompanyId();
  const name = useName();
  const queryClient = useQueryClient();
  const accounts = useAccounts(companyId);
  const canManage = useCan('accounts.manage');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');

  const remove = useMutation({
    mutationFn: (id: string) =>
      request<void>(`/companies/${companyId}/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts', companyId] }),
  });

  const rows = useMemo(() => asTree(accounts.data ?? []), [accounts.data]);
  const needle = search.trim().toLowerCase();
  const visible = needle
    ? rows.filter(
        ({ account }) =>
          account.code.includes(needle) ||
          account.name.en.toLowerCase().includes(needle) ||
          account.name.ar.includes(needle),
      )
    : rows;

  if (accounts.isPending) return <Loading />;
  if (accounts.error) return <ErrorText error={accounts.error} />;

  return (
    <>
      <PageHeader title={t('accounts.title')}>
        <span className="text-sm text-slate-500">
          {t('accounts.count', { count: accounts.data.length })}
        </span>
        <input
          type="search"
          aria-label={t('common.search')}
          placeholder={t('common.search')}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {canManage && (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => setCreating(!creating)}
          >
            {creating ? t('common.cancel') : t('accounts.new')}
          </button>
        )}
      </PageHeader>
      {creating && (
        <NewAccountForm
          companyId={companyId}
          accounts={accounts.data}
          onDone={() => setCreating(false)}
        />
      )}
      <ErrorText error={remove.error} />
      <Card className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>{t('common.code')}</th>
              <th className={thClass}>{t('common.name')}</th>
              <th className={thClass}>{t('accounts.type')}</th>
              <th className={thClass}>{t('accounts.subtype')}</th>
              <th className={thClass}>{t('accounts.concept')}</th>
              {canManage && <th className={thClass}>{t('common.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ account, depth }) => (
              <tr key={account.id} className={account.isPostable ? undefined : 'bg-slate-50'}>
                <td className={`${tdClass} tabular-nums`} dir="ltr">
                  {account.code}
                </td>
                <td
                  className={`${tdClass} ${account.isPostable ? '' : 'font-semibold'}`}
                  style={{ paddingInlineStart: `${0.75 + depth * 1.25}rem` }}
                >
                  {name(account.name)}
                </td>
                <td className={tdClass}>{t(`accountTypes.${account.type}`)}</td>
                <td className={tdClass}>{subtypeLabel(account.subtype, i18n.language)}</td>
                <td className={`${tdClass} text-xs text-slate-500`} dir="ltr">
                  {account.taxonomyConcept ?? ''}
                </td>
                {canManage && (
                  <td className={tdClass}>
                    <button
                      type="button"
                      className={dangerButtonClass}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(account.id)}
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
