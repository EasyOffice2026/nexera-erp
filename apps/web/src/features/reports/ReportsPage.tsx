import type { BalanceSheet, IncomeStatement, StatementLine, TrialBalance } from '@nexera/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useCompanies, useCompanyId, useName } from '../../app/company';
import {
  Amount,
  Card,
  ErrorText,
  Loading,
  numClass,
  PageHeader,
  secondaryButtonClass,
  tableClass,
  tdClass,
  thClass,
} from '../../components/ui';
import { request } from '../../lib/api';
import { exportTableToExcel } from '../../lib/export';
import { query } from '../../lib/format';
import { subtypeLabel } from '../../lib/subtype-labels';
import {
  CashFlowReport,
  ColumnOptions,
  ComparativeReport,
  GroupReport,
  JournalRegisterReport,
} from './AdvancedReports';
import { ReportFilters, useReportRange } from './ReportFilters';

const tabs = [
  'trialBalance',
  'incomeStatement',
  'comparative',
  'balanceSheet',
  'cashFlow',
  'journalRegister',
  'group',
] as const;
type Tab = (typeof tabs)[number];

function TrialBalanceReport() {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const name = useName();
  const [range] = useReportRange();
  const params = { from: range.from, to: range.to, branchId: range.branchId };
  const report = useQuery({
    queryKey: ['trial-balance', companyId, params],
    queryFn: () =>
      request<TrialBalance>(`/companies/${companyId}/reports/trial-balance${query(params)}`),
  });
  if (report.isPending) return <Loading />;
  if (report.error) return <ErrorText error={report.error} />;
  const { rows, totals } = report.data;
  const ledgerQuery = query({ from: range.from, to: range.to, branchId: range.branchId });

  return (
    <Card className="overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass} rowSpan={2}>
              {t('common.code')}
            </th>
            <th className={thClass} rowSpan={2}>
              {t('common.name')}
            </th>
            <th className={`${thClass} text-center`} colSpan={2}>
              {t('reports.opening')}
            </th>
            <th className={`${thClass} text-center`} colSpan={2}>
              {t('reports.movement')}
            </th>
            <th className={`${thClass} text-center`} colSpan={2}>
              {t('reports.closing')}
            </th>
          </tr>
          <tr>
            {[0, 1, 2].map((group) => [
              <th key={`d${group}`} className={`${thClass} text-end`}>
                {t('common.debit')}
              </th>,
              <th key={`c${group}`} className={`${thClass} text-end`}>
                {t('common.credit')}
              </th>,
            ])}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.accountId} className="hover:bg-slate-50">
              <td className={`${tdClass} tabular-nums`} dir="ltr">
                <Link
                  className="underline-offset-2 hover:underline"
                  to={`/c/${companyId}/reports/ledger/${row.accountId}${ledgerQuery}`}
                >
                  {row.code}
                </Link>
              </td>
              <td className={tdClass}>{name(row.name)}</td>
              <td className={numClass}>
                <Amount value={row.openingDebit} />
              </td>
              <td className={numClass}>
                <Amount value={row.openingCredit} />
              </td>
              <td className={numClass}>
                <Amount value={row.periodDebit} />
              </td>
              <td className={numClass}>
                <Amount value={row.periodCredit} />
              </td>
              <td className={numClass}>
                <Amount value={row.closingDebit} />
              </td>
              <td className={numClass}>
                <Amount value={row.closingCredit} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td className={tdClass} colSpan={2}>
              {t('common.total')}
            </td>
            <td className={numClass}>
              <Amount value={totals.openingDebit} />
            </td>
            <td className={numClass}>
              <Amount value={totals.openingCredit} />
            </td>
            <td className={numClass}>
              <Amount value={totals.periodDebit} />
            </td>
            <td className={numClass}>
              <Amount value={totals.periodCredit} />
            </td>
            <td className={numClass}>
              <Amount value={totals.closingDebit} />
            </td>
            <td className={numClass}>
              <Amount value={totals.closingCredit} />
            </td>
          </tr>
        </tfoot>
      </table>
      {rows.length === 0 && <p className="p-3 text-sm text-slate-500">{t('common.noData')}</p>}
    </Card>
  );
}

function StatementLines({ lines }: { lines: StatementLine[] }) {
  const { i18n } = useTranslation();
  const name = useName();
  return (
    <>
      {lines.map((line) => (
        <tbody key={line.key}>
          <tr>
            <td className={`${tdClass} font-medium`}>{subtypeLabel(line.key, i18n.language)}</td>
            <td className={numClass}>
              <Amount value={line.amount} />
            </td>
          </tr>
          {line.accounts.map((account) => (
            <tr key={account.accountId} className="text-slate-600">
              <td className={`${tdClass} ps-8`}>
                <span dir="ltr" className="tabular-nums">
                  {account.code}
                </span>{' '}
                · {name(account.name)}
              </td>
              <td className={numClass}>
                <Amount value={account.amount} />
              </td>
            </tr>
          ))}
        </tbody>
      ))}
    </>
  );
}

function TotalRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <tbody>
      <tr className={strong ? 'bg-slate-50 font-bold' : 'font-semibold'}>
        <td className={tdClass}>{label}</td>
        <td className={numClass}>
          <Amount value={value} />
        </td>
      </tr>
    </tbody>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <tbody>
      <tr>
        <th colSpan={2} className="px-3 pt-4 pb-1 text-start text-base font-semibold">
          {children}
        </th>
      </tr>
    </tbody>
  );
}

function IncomeStatementReport() {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const [range] = useReportRange();
  const params = { from: range.from, to: range.to, branchId: range.branchId };
  const report = useQuery({
    queryKey: ['income-statement', companyId, params],
    queryFn: () =>
      request<IncomeStatement>(`/companies/${companyId}/reports/income-statement${query(params)}`),
  });
  if (report.isPending) return <Loading />;
  if (report.error) return <ErrorText error={report.error} />;
  const data = report.data;
  return (
    <Card className="max-w-3xl overflow-x-auto">
      <table className={tableClass}>
        <Heading>{t('reports.revenue')}</Heading>
        <StatementLines lines={data.revenue} />
        <TotalRow label={t('reports.totalRevenue')} value={data.totalRevenue} />
        <TotalRow label={t('reports.costOfSales')} value={data.costOfSales} />
        <TotalRow label={t('reports.grossProfit')} value={data.grossProfit} strong />
        <Heading>{t('reports.expenses')}</Heading>
        <StatementLines lines={data.expenses} />
        <TotalRow label={t('reports.totalExpenses')} value={data.totalExpenses} />
        <TotalRow label={t('reports.netProfit')} value={data.netProfit} strong />
      </table>
    </Card>
  );
}

function BalanceSheetReport() {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const [range] = useReportRange();
  const params = { asOf: range.to, branchId: range.branchId };
  const report = useQuery({
    queryKey: ['balance-sheet', companyId, params],
    queryFn: () =>
      request<BalanceSheet>(`/companies/${companyId}/reports/balance-sheet${query(params)}`),
  });
  if (report.isPending) return <Loading />;
  if (report.error) return <ErrorText error={report.error} />;
  const data = report.data;
  return (
    <Card className="max-w-3xl overflow-x-auto">
      <p
        className={`mb-2 inline-block rounded px-2 py-0.5 text-xs ${
          data.balanced ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
        }`}
      >
        {data.balanced ? t('reports.balanced') : t('reports.notBalanced')}
      </p>
      <table className={tableClass}>
        <Heading>{t('reports.assets')}</Heading>
        <StatementLines lines={data.assets} />
        <TotalRow label={t('reports.totalAssets')} value={data.totalAssets} strong />
        <Heading>{t('reports.liabilities')}</Heading>
        <StatementLines lines={data.liabilities} />
        <TotalRow label={t('reports.totalLiabilities')} value={data.totalLiabilities} />
        <Heading>{t('reports.equity')}</Heading>
        <StatementLines lines={data.equity} />
        <TotalRow label={t('reports.currentYearProfit')} value={data.currentYearProfit} />
        <TotalRow label={t('reports.totalEquity')} value={data.totalEquity} />
      </table>
    </Card>
  );
}

export function ReportsPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const companyId = useCompanyId();
  const companies = useCompanies();
  const name = useName();
  const [range] = useReportRange();
  const tab: Tab = tabs.find((value) => value === params.get('tab')) ?? 'trialBalance';
  const company = companies.data?.find((row) => row.id === companyId);
  const asOf = tab === 'balanceSheet';
  const subject = tab === 'group' ? t('reports.group') : company ? name(company.name) : '';
  const dates = asOf ? range.to : `${range.from} – ${range.to}`;
  const title = `${subject} · ${t(`reports.${tab}`)} · ${dates}`;

  async function exportExcel() {
    const table = document.querySelector<HTMLTableElement>('#report-body table');
    if (!table) return;
    await exportTableToExcel(
      table,
      title,
      `${t(`reports.${tab}`)} ${asOf ? range.to : `${range.from} ${range.to}`}.xlsx`,
      i18n.language === 'ar',
    );
  }

  return (
    <>
      <div className="print:hidden">
        <PageHeader title={t('reports.title')}>
          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-200 p-1">
            {tabs.map((value) => (
              <button
                key={value}
                type="button"
                className={`rounded-md px-3 py-1 text-sm ${
                  value === tab ? 'bg-white shadow-sm' : 'text-slate-700'
                }`}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set('tab', value);
                  next.delete('page');
                  setParams(next, { replace: true });
                }}
              >
                {t(`reports.${value}`)}
              </button>
            ))}
          </div>
        </PageHeader>
      </div>
      <ReportFilters asOfOnly={asOf} withBranch={tab !== 'cashFlow' && tab !== 'group'}>
        {tab === 'comparative' && <ColumnOptions />}
        {tab === 'group' && <ColumnOptions withColumns={false} />}
        <div className="ms-auto flex gap-2">
          <button type="button" className={secondaryButtonClass} onClick={() => void exportExcel()}>
            {t('reports.exportExcel')}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={() => window.print()}>
            {t('reports.print')}
          </button>
        </div>
      </ReportFilters>
      <h2 className="mb-3 hidden text-lg font-semibold print:block">{title}</h2>
      <div id="report-body">
        {tab === 'trialBalance' && <TrialBalanceReport />}
        {tab === 'incomeStatement' && <IncomeStatementReport />}
        {tab === 'comparative' && <ComparativeReport />}
        {tab === 'balanceSheet' && <BalanceSheetReport />}
        {tab === 'cashFlow' && <CashFlowReport />}
        {tab === 'journalRegister' && <JournalRegisterReport />}
        {tab === 'group' && <GroupReport />}
      </div>
    </>
  );
}
