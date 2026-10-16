import { type Dashboard, type DashboardAmount, toFils } from '@nexera/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useBranches, useCompanies, useCompanyId, useName } from '../../app/company';
import {
  Amount,
  Card,
  ErrorText,
  Field,
  inputClass,
  Loading,
  PageHeader,
} from '../../components/ui';
import { request } from '../../lib/api';
import { query, today } from '../../lib/format';

type Span = 'month' | 'yearToDate';

// Change against the previous figure in percent with one decimal, or null when there is none.
function change(current: string, previous: string): string | null {
  const now = toFils(current);
  const before = toFils(previous);
  if (before === 0n) return null;
  const tenths = ((now - before) * 1000n) / (before < 0n ? -before : before);
  const abs = tenths < 0n ? -tenths : tenths;
  return `${tenths < 0n ? '-' : '+'}${abs / 10n}.${abs % 10n}%`;
}

// Share of the largest value in percent, only for drawing bars.
function share(value: string, max: bigint): number {
  const fils = toFils(value);
  if (max <= 0n || fils <= 0n) return 0;
  return Number((fils * 1000n) / max) / 10;
}

const largest = (values: string[]) =>
  values.reduce((top, value) => (toFils(value) > top ? toFils(value) : top), 0n);

function Kpi({ label, value, previous }: { label: string; value: string; previous?: string }) {
  const { t } = useTranslation();
  const delta = previous === undefined ? null : change(value, previous);
  return (
    <Card>
      <div className="text-sm text-slate-500">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold ${value.startsWith('-') ? 'text-red-700' : 'text-slate-900'}`}
      >
        <Amount value={value} />
      </div>
      {previous !== undefined && (
        <div className="mt-1 text-xs text-slate-500">
          {delta && (
            <span
              dir="ltr"
              className={`me-1 font-medium ${delta.startsWith('-') ? 'text-red-700' : 'text-emerald-700'}`}
            >
              {delta}
            </span>
          )}
          {t('dashboard.previousMonth')} <Amount value={previous} />
        </div>
      )}
    </Card>
  );
}

function Bars({ title, rows }: { title: string; rows: DashboardAmount[] }) {
  const { t } = useTranslation();
  const name = useName();
  const max = largest(rows.map((row) => row.amount));
  return (
    <Card>
      <h2 className="mb-3 font-medium text-slate-900">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t('dashboard.noData')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id ?? 'none'} className="text-sm">
              <div className="flex justify-between gap-2">
                <span className="truncate text-slate-700">
                  {row.code && <span className="me-1 text-slate-400">{row.code}</span>}
                  {row.name ? name(row.name) : t('dashboard.unassigned')}
                </span>
                <Amount value={row.amount} />
              </div>
              <div className="mt-1 h-1.5 rounded bg-slate-100">
                <div
                  className="h-1.5 rounded bg-sky-600"
                  style={{ width: `${share(row.amount, max)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Trend({ data }: { data: Dashboard['trend'] }) {
  const { t, i18n } = useTranslation();
  const max = largest(data.flatMap((point) => [point.revenue, point.expenses]));
  const label = new Intl.DateTimeFormat(`${i18n.language}-u-nu-latn`, {
    month: 'short',
    timeZone: 'UTC',
  });
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium text-slate-900">{t('dashboard.trend')}</h2>
        <div className="flex gap-3 text-xs text-slate-600">
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-sm bg-sky-600" />
            {t('dashboard.revenue')}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-sm bg-amber-500" />
            {t('dashboard.allExpenses')}
          </span>
        </div>
      </div>
      <div className="flex h-48 items-end gap-1" dir="ltr">
        {data.map((point) => (
          <div
            key={point.month}
            className="flex h-full flex-1 flex-col items-center justify-end"
            title={`${point.month} · ${t('dashboard.revenue')} ${point.revenue} · ${t('dashboard.allExpenses')} ${point.expenses} · ${t('dashboard.netProfit')} ${point.netProfit}`}
          >
            <div className="flex w-full flex-1 items-end justify-center gap-0.5">
              <div
                className="w-1/3 rounded-t bg-sky-600"
                style={{ height: `${share(point.revenue, max)}%` }}
              />
              <div
                className="w-1/3 rounded-t bg-amber-500"
                style={{ height: `${share(point.expenses, max)}%` }}
              />
            </div>
            <div className="mt-1 text-[10px] text-slate-500">
              {label.format(new Date(`${point.month}-01T00:00:00Z`))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Alerts({ alerts, companyId }: { alerts: Dashboard['alerts']; companyId: string }) {
  const { t } = useTranslation();
  const items: { to: string; text: string }[] = [];
  if (alerts.draftJournals > 0) {
    items.push({
      to: `/c/${companyId}/journals?status=DRAFT`,
      text: t('dashboard.alerts.drafts', { count: alerts.draftJournals }),
    });
  }
  if (alerts.unclosedPastPeriods > 0) {
    items.push({
      to: `/c/${companyId}/periods`,
      text: t('dashboard.alerts.unclosed', { count: alerts.unclosedPastPeriods }),
    });
  }
  if (!alerts.periodOpen) {
    items.push({ to: `/c/${companyId}/periods`, text: t('dashboard.alerts.noPeriod') });
  }
  if (items.length === 0) return null;
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.text}>
          <Link
            to={item.to}
            className="block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 hover:bg-amber-100"
          >
            {item.text}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SpanTitle({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <h2 className="text-sm font-medium text-slate-600">
      {label}{' '}
      <span dir="ltr">
        ({from} – {to})
      </span>
    </h2>
  );
}

function DashboardBody({ data, companyId }: { data: Dashboard; companyId: string }) {
  const { t } = useTranslation();
  const name = useName();
  const [span, setSpan] = useState<Span>('month');
  const { month, previousMonth, yearToDate } = data.figures;
  const breakdown = data.breakdown[span];
  const tab = (value: Span) =>
    `rounded-md px-3 py-1 text-sm ${
      span === value ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-200'
    }`;

  return (
    <div className="space-y-4">
      <Alerts alerts={data.alerts} companyId={companyId} />
      <SpanTitle label={t('dashboard.thisMonth')} {...data.spans.month} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label={t('dashboard.revenue')}
          value={month.revenue}
          previous={previousMonth.revenue}
        />
        <Kpi
          label={t('dashboard.grossProfit')}
          value={month.grossProfit}
          previous={previousMonth.grossProfit}
        />
        <Kpi
          label={t('dashboard.expenses')}
          value={month.expenses}
          previous={previousMonth.expenses}
        />
        <Kpi
          label={t('dashboard.netProfit')}
          value={month.netProfit}
          previous={previousMonth.netProfit}
        />
      </div>
      <SpanTitle label={t('dashboard.yearToDate')} {...data.spans.yearToDate} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label={t('dashboard.revenue')} value={yearToDate.revenue} />
        <Kpi label={t('dashboard.netProfit')} value={yearToDate.netProfit} />
        <Kpi label={t('dashboard.receivables')} value={data.receivables} />
        <Kpi label={t('dashboard.payables')} value={data.payables} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Trend data={data.trend} />
        </div>
        <Card>
          <div className="flex justify-between gap-2">
            <h2 className="font-medium text-slate-900">{t('dashboard.cash')}</h2>
            <span className="font-semibold">
              <Amount value={data.cash.total} />
            </span>
          </div>
          {data.cash.accounts.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">{t('dashboard.noData')}</p>
          ) : (
            <ul className="mt-3 space-y-1 text-sm">
              {data.cash.accounts.map((account) => (
                <li key={account.id} className="flex justify-between gap-2 text-slate-700">
                  <Link
                    to={`/c/${companyId}/reports/ledger/${account.id ?? ''}?to=${data.asOf}`}
                    className="truncate hover:underline"
                  >
                    <span className="me-1 text-slate-400">{account.code}</span>
                    {account.name ? name(account.name) : ''}
                  </Link>
                  <Amount value={account.amount} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="flex gap-1">
        <button type="button" className={tab('month')} onClick={() => setSpan('month')}>
          {t('dashboard.thisMonth')}
        </button>
        <button type="button" className={tab('yearToDate')} onClick={() => setSpan('yearToDate')}>
          {t('dashboard.yearToDate')}
        </button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Bars title={t('dashboard.revenueByBranch')} rows={breakdown.revenueByBranch} />
        <Bars title={t('dashboard.revenueByBrand')} rows={breakdown.revenueByBrand} />
        <Bars title={t('dashboard.revenueByChannel')} rows={breakdown.revenueByChannel} />
        <Bars title={t('dashboard.topExpenses')} rows={breakdown.topExpenses} />
      </div>
    </div>
  );
}

// The landing page of a company: its own figures only.
export function DashboardPage() {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const companies = useCompanies();
  const branches = useBranches(companyId);
  const name = useName();
  const [params, setParams] = useSearchParams();
  const filters = { asOf: params.get('asOf') ?? today(), branchId: params.get('branchId') ?? '' };
  const dashboard = useQuery({
    queryKey: ['dashboard', companyId, filters],
    queryFn: () => request<Dashboard>(`/companies/${companyId}/dashboard${query(filters)}`),
  });
  const company = companies.data?.find((candidate) => candidate.id === companyId);

  const update = (key: 'asOf' | 'branchId', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title={company ? name(company.name) : t('nav.dashboard')}>
        <Field label={t('common.asOf')}>
          <input
            type="date"
            className={inputClass}
            value={filters.asOf}
            onChange={(event) => update('asOf', event.target.value)}
          />
        </Field>
        <Field label={t('common.branch')}>
          <select
            className={inputClass}
            value={filters.branchId}
            onChange={(event) => update('branchId', event.target.value)}
          >
            <option value="">{t('common.allBranches')}</option>
            {branches.data?.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {name(branch.name)}
              </option>
            ))}
          </select>
        </Field>
      </PageHeader>
      {dashboard.isPending ? (
        <Loading />
      ) : dashboard.error ? (
        <ErrorText error={dashboard.error} />
      ) : (
        <DashboardBody key={companyId} data={dashboard.data} companyId={companyId} />
      )}
    </>
  );
}
