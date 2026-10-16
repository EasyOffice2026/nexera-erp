import {
  type CashFlowStatement,
  type ColumnIncomeStatement,
  type ColumnLine,
  columnModes,
  compareModes,
  type JournalRegister,
  journalSources,
  type ReportColumn,
} from '@nexera/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useAccounts, useCompanyId, useName } from '../../app/company';
import {
  Amount,
  Card,
  ErrorText,
  Field,
  inputClass,
  Loading,
  numClass,
  secondaryButtonClass,
  tableClass,
  tdClass,
  thClass,
} from '../../components/ui';
import { request } from '../../lib/api';
import { query } from '../../lib/format';
import { subtypeLabel } from '../../lib/subtype-labels';
import { useReportRange } from './ReportFilters';

// The column and comparison choices of the multi-column statements live in the address too.
export function useColumnOptions() {
  const [params, setParams] = useSearchParams();
  const columns = columnModes.find((value) => value === params.get('columns')) ?? 'none';
  const compare = compareModes.find((value) => value === params.get('compare')) ?? 'none';
  const set = (key: 'columns' | 'compare', value: string) => {
    const next = new URLSearchParams(params);
    if (value === 'none') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  return { columns, compare, set };
}

export function ColumnOptions({ withColumns = true }: { withColumns?: boolean }) {
  const { t } = useTranslation();
  const { columns, compare, set } = useColumnOptions();
  return (
    <>
      {withColumns && (
        <Field label={t('reports.columns')}>
          <select
            className={inputClass}
            value={columns}
            onChange={(e) => set('columns', e.target.value)}
          >
            {columnModes.map((mode) => (
              <option key={mode} value={mode}>
                {t(`reports.columnModes.${mode}`)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={t('reports.compare')}>
        <select
          className={inputClass}
          value={compare}
          onChange={(e) => set('compare', e.target.value)}
        >
          {compareModes.map((mode) => (
            <option key={mode} value={mode}>
              {t(`reports.compareModes.${mode}`)}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

function ColumnTitle({ column }: { column: ReportColumn }) {
  const { t, i18n } = useTranslation();
  const name = useName();
  switch (column.kind) {
    case 'period': {
      if (column.key.includes('Q')) {
        const [year, quarter] = column.key.split('-');
        return <>{`${quarter} ${year}`}</>;
      }
      const month = new Date(`${column.key}-01T00:00:00Z`);
      return (
        <>
          {new Intl.DateTimeFormat(i18n.language, {
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          }).format(month)}
        </>
      );
    }
    case 'branch':
    case 'brand':
    case 'company':
      return <>{column.name ? name(column.name) : ''}</>;
    case 'unassigned':
      return <>{t('reports.unassigned')}</>;
    case 'total':
      return <>{t('common.total')}</>;
    case 'comparison':
      return (
        <>
          {t('reports.comparison')}
          <span className="block text-xs font-normal text-slate-500" dir="ltr">
            {column.from} – {column.to}
          </span>
        </>
      );
    case 'variance':
      return <>{t('reports.variance')}</>;
  }
}

// Opens the ledger of an account for the dates and branch of one column.
function ledgerLink(companyId: string, accountId: string, column: ReportColumn) {
  return `/c/${companyId}/reports/ledger/${accountId}${query({
    from: column.from,
    to: column.to,
    branchId: column.branchId ?? undefined,
  })}`;
}

function Lines({
  lines,
  columns,
  companyId,
}: {
  lines: ColumnLine[];
  columns: ReportColumn[];
  companyId: string | null;
}) {
  const { i18n } = useTranslation();
  const name = useName();
  return (
    <>
      {lines.map((line) => (
        <tbody key={line.key}>
          <tr>
            <td className={`${tdClass} font-medium`}>{subtypeLabel(line.key, i18n.language)}</td>
            {line.amounts.map((amount, i) => (
              <td key={columns[i]!.key} className={`${numClass} font-medium`}>
                <Amount value={amount} />
              </td>
            ))}
          </tr>
          {line.accounts.map((account) => (
            <tr key={account.accountId ?? account.code} className="text-slate-600">
              <td className={`${tdClass} ps-8`}>
                <span dir="ltr" className="tabular-nums">
                  {account.code}
                </span>{' '}
                · {name(account.name)}
              </td>
              {account.amounts.map((amount, i) => {
                const column = columns[i]!;
                const drill =
                  companyId &&
                  account.accountId &&
                  column.kind !== 'variance' &&
                  column.kind !== 'unassigned';
                return (
                  <td key={column.key} className={numClass}>
                    {drill ? (
                      <Link
                        className="underline-offset-2 hover:underline"
                        to={ledgerLink(companyId, account.accountId!, column)}
                      >
                        <Amount value={amount} />
                      </Link>
                    ) : (
                      <Amount value={amount} />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      ))}
    </>
  );
}

function Totals({
  label,
  values,
  strong = false,
}: {
  label: string;
  values: string[];
  strong?: boolean;
}) {
  return (
    <tbody>
      <tr className={strong ? 'bg-slate-50 font-bold' : 'font-semibold'}>
        <td className={tdClass}>{label}</td>
        {values.map((value, i) => (
          <td key={i} className={numClass}>
            <Amount value={value} />
          </td>
        ))}
      </tr>
    </tbody>
  );
}

function SectionHeading({ label, span }: { label: string; span: number }) {
  return (
    <tbody>
      <tr>
        <th colSpan={span} className="px-3 pt-4 pb-1 text-start text-base font-semibold">
          {label}
        </th>
      </tr>
    </tbody>
  );
}

export function ColumnStatementTable({
  data,
  companyId,
}: {
  data: ColumnIncomeStatement;
  companyId: string | null;
}) {
  const { t } = useTranslation();
  const span = data.columns.length + 1;
  return (
    <Card className="overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass}>{t('common.name')}</th>
            {data.columns.map((column) => (
              <th key={column.key} className={`${thClass} text-end whitespace-nowrap`}>
                <ColumnTitle column={column} />
              </th>
            ))}
          </tr>
        </thead>
        <SectionHeading label={t('reports.revenue')} span={span} />
        <Lines lines={data.revenue} columns={data.columns} companyId={companyId} />
        <Totals label={t('reports.totalRevenue')} values={data.totalRevenue} />
        <Lines lines={data.costOfSales} columns={data.columns} companyId={companyId} />
        <Totals label={t('reports.grossProfit')} values={data.grossProfit} strong />
        <SectionHeading label={t('reports.expenses')} span={span} />
        <Lines lines={data.expenses} columns={data.columns} companyId={companyId} />
        <Totals label={t('reports.totalExpenses')} values={data.totalExpenses} />
        <Totals label={t('reports.netProfit')} values={data.netProfit} strong />
      </table>
    </Card>
  );
}

export function ComparativeReport() {
  const companyId = useCompanyId();
  const [range] = useReportRange();
  const { columns, compare } = useColumnOptions();
  const params = { from: range.from, to: range.to, branchId: range.branchId, columns, compare };
  const report = useQuery({
    queryKey: ['income-statement-columns', companyId, params],
    queryFn: () =>
      request<ColumnIncomeStatement>(
        `/companies/${companyId}/reports/income-statement/columns${query(params)}`,
      ),
  });
  if (report.isPending) return <Loading />;
  if (report.error) return <ErrorText error={report.error} />;
  return <ColumnStatementTable data={report.data} companyId={companyId} />;
}

export function GroupReport() {
  const { t } = useTranslation();
  const [range] = useReportRange();
  const { compare } = useColumnOptions();
  const params = { from: range.from, to: range.to, compare };
  const report = useQuery({
    queryKey: ['group-income-statement', params],
    queryFn: () =>
      request<ColumnIncomeStatement>(`/reports/group/income-statement${query(params)}`),
  });
  if (report.isPending) return <Loading />;
  if (report.error) return <ErrorText error={report.error} />;
  return (
    <>
      <p className="mb-3 text-sm text-slate-600">{t('reports.groupNote')}</p>
      <ColumnStatementTable data={report.data} companyId={null} />
    </>
  );
}

function Row({
  label,
  value,
  indent = false,
  strong = false,
  to,
}: {
  label: string;
  value: string;
  indent?: boolean;
  strong?: boolean;
  to?: string;
}) {
  return (
    <tr className={strong ? 'bg-slate-50 font-semibold' : indent ? 'text-slate-600' : ''}>
      <td className={`${tdClass} ${indent ? 'ps-8' : ''}`}>{label}</td>
      <td className={numClass}>
        {to ? (
          <Link className="underline-offset-2 hover:underline" to={to}>
            <Amount value={value} />
          </Link>
        ) : (
          <Amount value={value} />
        )}
      </td>
    </tr>
  );
}

export function CashFlowReport() {
  const { t, i18n } = useTranslation();
  const companyId = useCompanyId();
  const name = useName();
  const [range] = useReportRange();
  const params = { from: range.from, to: range.to };
  const report = useQuery({
    queryKey: ['cash-flow', companyId, params],
    queryFn: () =>
      request<CashFlowStatement>(`/companies/${companyId}/reports/cash-flow${query(params)}`),
  });
  if (report.isPending) return <Loading />;
  if (report.error) return <ErrorText error={report.error} />;
  const data = report.data;
  const ledger = (accountId: string) =>
    `/c/${companyId}/reports/ledger/${accountId}${query(params)}`;
  const sections = [
    ['operating', 'netOperating'],
    ['investing', 'netInvesting'],
    ['financing', 'netFinancing'],
  ] as const;

  return (
    <Card className="max-w-3xl overflow-x-auto">
      <p
        className={`mb-2 inline-block rounded px-2 py-0.5 text-xs ${
          data.balanced ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
        }`}
      >
        {data.balanced ? t('reports.cashBalanced') : t('reports.cashNotBalanced')}
      </p>
      <table className={tableClass}>
        {sections.map(([key, totalKey]) => (
          <tbody key={key}>
            <tr>
              <th colSpan={2} className="px-3 pt-4 pb-1 text-start text-base font-semibold">
                {t(`reports.${key}`)}
              </th>
            </tr>
            {key === 'operating' && <Row label={t('reports.netProfit')} value={data.netProfit} />}
            {data[key].lines.map((line) => [
              <Row
                key={line.key}
                label={
                  line.key === 'accumulated_depreciation'
                    ? t('reports.depreciationAddBack')
                    : t('reports.changeIn', { name: subtypeLabel(line.key, i18n.language) })
                }
                value={line.amount}
              />,
              ...line.accounts.map((account) => (
                <Row
                  key={account.accountId}
                  label={`${account.code} · ${name(account.name)}`}
                  value={account.amount}
                  indent
                  to={ledger(account.accountId)}
                />
              )),
            ])}
            <Row label={t(`reports.${totalKey}`)} value={data[key].total} strong />
          </tbody>
        ))}
        <tbody>
          <tr>
            <td colSpan={2} className="pt-3" />
          </tr>
          <Row label={t('reports.netChange')} value={data.netChange} strong />
          <Row label={t('reports.openingCash')} value={data.openingCash} />
          <Row label={t('reports.closingCash')} value={data.closingCash} strong />
        </tbody>
      </table>
    </Card>
  );
}

const REGISTER_PAGE_SIZE = 100;

export function JournalRegisterReport() {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const name = useName();
  const accounts = useAccounts(companyId);
  const [range] = useReportRange();
  const [search, setSearch] = useSearchParams();
  const accountId = search.get('accountId') ?? '';
  const source = journalSources.find((value) => value === search.get('source')) ?? '';
  const page = Math.max(1, Number(search.get('page') ?? 1) || 1);
  const params = {
    from: range.from,
    to: range.to,
    branchId: range.branchId,
    accountId,
    source,
    page,
    pageSize: REGISTER_PAGE_SIZE,
  };
  const report = useQuery({
    queryKey: ['journal-register', companyId, params],
    queryFn: () =>
      request<JournalRegister>(`/companies/${companyId}/reports/journal-register${query(params)}`),
  });
  const set = (change: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(change)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearch(next, { replace: true });
  };

  const filters = (
    <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
      <Field label={t('reports.account')}>
        <select
          className={inputClass}
          value={accountId}
          onChange={(e) => set({ accountId: e.target.value, page: '' })}
        >
          <option value="">{t('reports.allAccounts')}</option>
          {accounts.data
            ?.filter((account) => account.isPostable)
            .map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {name(account.name)}
              </option>
            ))}
        </select>
      </Field>
      <Field label={t('reports.source')}>
        <select
          className={inputClass}
          value={source}
          onChange={(e) => set({ source: e.target.value, page: '' })}
        >
          <option value="">{t('reports.allSources')}</option>
          {journalSources.map((value) => (
            <option key={value} value={value}>
              {t(`journalSource.${value}`)}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );

  if (report.isPending)
    return (
      <>
        {filters}
        <Loading />
      </>
    );
  if (report.error)
    return (
      <>
        {filters}
        <ErrorText error={report.error} />
      </>
    );
  const data = report.data;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <>
      {filters}
      <Card className="overflow-x-auto">
        <p className="mb-2 text-sm text-slate-600">
          {t('reports.journalCount', { count: data.total })}
        </p>
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>{t('common.date')}</th>
              <th className={thClass}>#</th>
              <th className={thClass}>{t('common.description')}</th>
              <th className={thClass}>{t('reports.account')}</th>
              <th className={thClass}>{t('common.branch')}</th>
              <th className={`${thClass} text-end`}>{t('common.debit')}</th>
              <th className={`${thClass} text-end`}>{t('common.credit')}</th>
            </tr>
          </thead>
          {data.entries.map((entry) => (
            <tbody key={entry.id} className="border-b-2 border-slate-200">
              {entry.lines.map((line, i) => (
                <tr key={i}>
                  {i === 0 && (
                    <>
                      <td
                        className={`${tdClass} align-top whitespace-nowrap`}
                        rowSpan={entry.lines.length}
                        dir="ltr"
                      >
                        {entry.date}
                      </td>
                      <td
                        className={`${tdClass} align-top tabular-nums`}
                        rowSpan={entry.lines.length}
                      >
                        <Link
                          className="underline-offset-2 hover:underline"
                          to={`/c/${companyId}/journals/${entry.id}`}
                        >
                          {entry.number}
                        </Link>
                      </td>
                      <td className={`${tdClass} align-top`} rowSpan={entry.lines.length}>
                        {entry.description}
                        {entry.reference && (
                          <span className="block text-xs text-slate-500">{entry.reference}</span>
                        )}
                        <span className="block text-xs text-slate-500">
                          {t(`journalSource.${entry.source}`)}
                        </span>
                      </td>
                    </>
                  )}
                  <td className={tdClass}>
                    <span dir="ltr" className="tabular-nums">
                      {line.code}
                    </span>{' '}
                    · {name(line.name)}
                    {line.description && (
                      <span className="block text-xs text-slate-500">{line.description}</span>
                    )}
                  </td>
                  <td className={tdClass}>{line.branchName ? name(line.branchName) : ''}</td>
                  <td className={numClass}>
                    <Amount value={line.debit} />
                  </td>
                  <td className={numClass}>
                    <Amount value={line.credit} />
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
          <tfoot>
            <tr className="font-semibold">
              <td className={tdClass} colSpan={5}>
                {t('common.total')}
              </td>
              <td className={numClass}>
                <Amount value={data.totalDebit} />
              </td>
              <td className={numClass}>
                <Amount value={data.totalCredit} />
              </td>
            </tr>
          </tfoot>
        </table>
        {data.total === 0 && <p className="p-3 text-sm text-slate-500">{t('common.noData')}</p>}
        {pages > 1 && (
          <div className="mt-3 flex items-center gap-2 text-sm print:hidden">
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={page <= 1}
              onClick={() => set({ page: String(page - 1) })}
            >
              {t('common.previous')}
            </button>
            <span>{t('common.pageOf', { page, pages })}</span>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={page >= pages}
              onClick={() => set({ page: String(page + 1) })}
            >
              {t('common.next')}
            </button>
          </div>
        )}
      </Card>
    </>
  );
}
