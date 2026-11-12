import type { LocalizedName } from '@nexera/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccounts, useCompanies, useName } from '../../app/company';
import {
  Amount,
  buttonClass,
  Card,
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
import { today } from '../../lib/format';
import { useCan } from '../auth/auth-context';

interface Connection {
  apiUrl: string;
  webUrl: string;
  lastSyncAt: string | null;
  lastError: string | null;
}
interface Structure {
  brands: {
    id: string;
    name: LocalizedName;
    branches: { id: string; name: LocalizedName; isActive: boolean; erpBranchId: string | null }[];
  }[];
  erpBranches: {
    id: string;
    code: string;
    name: LocalizedName;
    companyId: string;
    companyName: LocalizedName;
  }[];
}
interface RoleAccount {
  role: string;
  accountId: string | null;
}
interface PosDocument {
  id: string;
  companyId: string;
  externalId: string;
  kind: 'day' | 'grn';
  businessDate: string;
  amount: string;
  status: 'posted' | 'unmapped' | 'failed';
  error: string | null;
}
interface SyncResult {
  posted: number;
  unchanged: number;
  unmapped: number;
  failed: number;
  unlinked: number;
}

// The link with the POS (docs/unified-platform.md): where it is, which ERP branch each POS
// branch posts to, the accounts of each company, and what has been posted.
export function PosPage() {
  const { t } = useTranslation();
  const canManage = useCan('integrations.manage');
  const connection = useQuery({
    queryKey: ['pos', 'connection'],
    queryFn: () => request<{ connection: Connection | null }>('/pos/connection'),
  });

  if (connection.isPending) return <Loading />;
  if (connection.error) return <ErrorText error={connection.error} />;
  const current = connection.data.connection;

  return (
    <>
      <PageHeader title={t('pos.title')}>{current && <OpenPosButton />}</PageHeader>
      <p className="mb-4 text-sm text-slate-600">{t('pos.intro')}</p>
      {canManage && <ConnectionCard current={current} />}
      {current && canManage && <BranchLinksCard />}
      {current && <AccountsCard canManage={canManage} />}
      {current && canManage && <SyncCard />}
      {current && <DocumentsCard />}
    </>
  );
}

export function OpenPosButton() {
  const { t } = useTranslation();
  const open = useMutation({
    mutationFn: () => request<{ url: string }>('/pos/sso', { method: 'POST' }),
    onSuccess: ({ url }) => {
      window.open(url, '_blank', 'noopener');
    },
  });
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        className={secondaryButtonClass}
        disabled={open.isPending}
        onClick={() => open.mutate()}
      >
        {t('pos.open')}
      </button>
      {open.error && <ErrorText error={open.error} />}
    </span>
  );
}

function ConnectionCard({ current }: { current: Connection | null }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiUrl, setApiUrl] = useState(current?.apiUrl ?? '');
  const [webUrl, setWebUrl] = useState(current?.webUrl ?? '');
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: () =>
      request<{ connection: Connection }>('/pos/connection', {
        method: 'PUT',
        body: { apiUrl, webUrl, ...(key ? { key } : {}) },
      }),
    onSuccess: () => {
      setKey('');
      return queryClient.invalidateQueries({ queryKey: ['pos'] });
    },
  });
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }
  return (
    <Card className="mb-4">
      <h2 className="mb-3 font-semibold">{t('pos.connection')}</h2>
      <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-3">
        <Field label={t('pos.apiUrl')}>
          <input
            type="url"
            required
            dir="ltr"
            className={inputClass}
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
          />
        </Field>
        <Field label={t('pos.webUrl')}>
          <input
            type="url"
            required
            dir="ltr"
            className={inputClass}
            value={webUrl}
            onChange={(e) => setWebUrl(e.target.value)}
          />
        </Field>
        <Field label={current ? t('pos.newKey') : t('pos.key')}>
          <input
            type="password"
            required={!current}
            dir="ltr"
            autoComplete="off"
            className={inputClass}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <div className="flex items-center gap-3 md:col-span-3">
          <button type="submit" className={buttonClass} disabled={save.isPending}>
            {t('common.save')}
          </button>
          {current && (
            <span className="text-sm text-slate-500">
              {t('pos.lastSync')}:{' '}
              <span dir="ltr">
                {current.lastSyncAt ? new Date(current.lastSyncAt).toLocaleString() : '—'}
              </span>
            </span>
          )}
          {current?.lastError && <span className="text-sm text-red-700">{current.lastError}</span>}
        </div>
        <ErrorText error={save.error} />
      </form>
    </Card>
  );
}

function BranchLinksCard() {
  const { t } = useTranslation();
  const name = useName();
  const queryClient = useQueryClient();
  const structure = useQuery({
    queryKey: ['pos', 'structure'],
    queryFn: () => request<Structure>('/pos/structure'),
  });
  const [changes, setChanges] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (data: Structure) =>
      request('/pos/branch-links', {
        method: 'PUT',
        body: {
          links: data.brands.flatMap((brand) =>
            brand.branches.map((branch) => ({
              posBranchId: branch.id,
              posBrandId: brand.id,
              branchId: (changes[branch.id] ?? branch.erpBranchId ?? '') || null,
            })),
          ),
        },
      }),
    onSuccess: () => {
      setChanges({});
      return queryClient.invalidateQueries({ queryKey: ['pos'] });
    },
  });

  return (
    <Card className="mb-4 overflow-x-auto">
      <h2 className="mb-1 font-semibold">{t('pos.branchLinks')}</h2>
      <p className="mb-3 text-sm text-slate-500">{t('pos.branchLinksHint')}</p>
      {structure.isPending && <Loading />}
      <ErrorText error={structure.error} />
      {structure.data && (
        <>
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>{t('pos.posBrand')}</th>
                <th className={thClass}>{t('pos.posBranch')}</th>
                <th className={thClass}>{t('pos.erpBranch')}</th>
              </tr>
            </thead>
            <tbody>
              {structure.data.brands.flatMap((brand) =>
                brand.branches.map((branch) => (
                  <tr key={branch.id}>
                    <td className={tdClass}>{name(brand.name)}</td>
                    <td className={tdClass}>{name(branch.name)}</td>
                    <td className={tdClass}>
                      <select
                        aria-label={t('pos.erpBranch')}
                        className={inputClass}
                        value={changes[branch.id] ?? branch.erpBranchId ?? ''}
                        onChange={(e) =>
                          setChanges((prev) => ({ ...prev, [branch.id]: e.target.value }))
                        }
                      >
                        <option value="">{t('pos.notLinked')}</option>
                        {structure.data.erpBranches.map((erp) => (
                          <option key={erp.id} value={erp.id}>
                            {name(erp.companyName)} · {erp.code} {name(erp.name)}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              className={buttonClass}
              disabled={save.isPending || Object.keys(changes).length === 0}
              onClick={() => save.mutate(structure.data)}
            >
              {t('common.save')}
            </button>
            <ErrorText error={save.error} />
          </div>
        </>
      )}
    </Card>
  );
}

function AccountsCard({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const name = useName();
  const companies = useCompanies();
  const [chosen, setChosen] = useState('');
  const companyId = chosen || companies.data?.[0]?.id || '';
  return (
    <Card className="mb-4 overflow-x-auto">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">{t('pos.accounts')}</h2>
        <select
          aria-label={t('nav.company')}
          className={inputClass + ' w-auto'}
          value={companyId}
          onChange={(e) => setChosen(e.target.value)}
        >
          {companies.data?.map((company) => (
            <option key={company.id} value={company.id}>
              {name(company.name)}
            </option>
          ))}
        </select>
      </div>
      <p className="mb-3 text-sm text-slate-500">{t('pos.accountsHint')}</p>
      {companyId && <AccountsTable key={companyId} companyId={companyId} canManage={canManage} />}
    </Card>
  );
}

const baseRoles = [
  'sales',
  'discounts',
  'refunds',
  'commission',
  'cash_over_short',
  'cost_of_sales',
  'inventory',
  'waste',
  'payable',
] as const;

function roleLabel(role: string, t: ReturnType<typeof useTranslation>['t']): string {
  if (role.startsWith('method:')) {
    return t('pos.role.method', { method: role.slice('method:'.length) });
  }
  const base = baseRoles.find((known) => known === role);
  return base ? t(`pos.role.${base}`) : role;
}

function AccountsTable({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const { t } = useTranslation();
  const name = useName();
  const queryClient = useQueryClient();
  const accounts = useAccounts(companyId);
  const roles = useQuery({
    queryKey: ['pos', 'accounts', companyId],
    queryFn: () => request<RoleAccount[]>(`/pos/companies/${companyId}/accounts`),
  });
  const [changes, setChanges] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      request(`/pos/companies/${companyId}/accounts`, {
        method: 'PUT',
        body: {
          accounts: Object.entries(changes).map(([role, accountId]) => ({ role, accountId })),
        },
      }),
    onSuccess: () => {
      setChanges({});
      return queryClient.invalidateQueries({ queryKey: ['pos'] });
    },
  });
  if (roles.isPending || accounts.isPending) return <Loading />;
  if (roles.error) return <ErrorText error={roles.error} />;
  const postable = (accounts.data ?? []).filter((row) => row.isPostable && row.isActive);
  return (
    <>
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass}>{t('pos.figure')}</th>
            <th className={thClass}>{t('pos.account')}</th>
          </tr>
        </thead>
        <tbody>
          {roles.data.map((row) => (
            <tr key={row.role}>
              <td className={tdClass}>{roleLabel(row.role, t)}</td>
              <td className={tdClass}>
                <select
                  aria-label={roleLabel(row.role, t)}
                  disabled={!canManage}
                  className={`${inputClass} ${row.accountId || changes[row.role] ? '' : 'border-red-400'}`}
                  value={changes[row.role] ?? row.accountId ?? ''}
                  onChange={(e) => setChanges((prev) => ({ ...prev, [row.role]: e.target.value }))}
                >
                  <option value="" disabled>
                    {t('pos.noAccount')}
                  </option>
                  {postable.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} {name(account.name)}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canManage && (
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            className={buttonClass}
            disabled={save.isPending || Object.keys(changes).length === 0}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </button>
          <ErrorText error={save.error} />
        </div>
      )}
    </>
  );
}

function SyncCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const sync = useMutation({
    mutationFn: () => request<SyncResult>('/pos/sync', { method: 'POST', body: { from, to } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pos'] }),
  });
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    sync.mutate();
  }
  return (
    <Card className="mb-4">
      <h2 className="mb-1 font-semibold">{t('pos.sync')}</h2>
      <p className="mb-3 text-sm text-slate-500">{t('pos.syncHint')}</p>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <Field label={t('common.from')}>
          <input
            type="date"
            required
            className={inputClass}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label={t('common.to')}>
          <input
            type="date"
            required
            className={inputClass}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <button type="submit" className={buttonClass} disabled={sync.isPending}>
          {t('pos.syncNow')}
        </button>
        {sync.data && (
          <span className="text-sm text-slate-700">{t('pos.syncResult', { ...sync.data })}</span>
        )}
      </form>
      <div className="mt-3">
        <ErrorText error={sync.error} />
      </div>
    </Card>
  );
}

function DocumentsCard() {
  const { t } = useTranslation();
  const name = useName();
  const companies = useCompanies();
  const documents = useQuery({
    queryKey: ['pos', 'documents'],
    queryFn: () => request<PosDocument[]>('/pos/documents'),
  });
  const companyName = (id: string) => {
    const company = companies.data?.find((row) => row.id === id);
    return company ? name(company.name) : '';
  };
  const statusClass = {
    posted: 'bg-emerald-50 text-emerald-700',
    unmapped: 'bg-amber-50 text-amber-800',
    failed: 'bg-red-50 text-red-700',
  } as const;
  return (
    <Card className="mb-4 overflow-x-auto">
      <h2 className="mb-3 font-semibold">{t('pos.documents')}</h2>
      {documents.isPending && <Loading />}
      <ErrorText error={documents.error} />
      {documents.data?.length === 0 && (
        <p className="text-sm text-slate-500">{t('pos.noDocuments')}</p>
      )}
      {documents.data && documents.data.length > 0 && (
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>{t('pos.businessDate')}</th>
              <th className={thClass}>{t('nav.company')}</th>
              <th className={thClass}>{t('pos.kind')}</th>
              <th className={`${thClass} text-end`}>{t('pos.amount')}</th>
              <th className={thClass}>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {documents.data.map((doc) => (
              <tr key={doc.id}>
                <td className={`${tdClass} tabular-nums`} dir="ltr">
                  {doc.businessDate}
                </td>
                <td className={tdClass}>{companyName(doc.companyId)}</td>
                <td className={tdClass}>{t(`pos.kinds.${doc.kind}`)}</td>
                <td className={`${tdClass} text-end`}>
                  <Amount value={doc.amount} />
                </td>
                <td className={tdClass}>
                  <span className={`rounded px-2 py-0.5 text-xs ${statusClass[doc.status]}`}>
                    {t(`pos.status.${doc.status}`)}
                  </span>
                  {doc.error && <span className="ms-2 text-xs text-slate-500">{doc.error}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
