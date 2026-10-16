import type { AccountLedger } from '@nexera/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useCompanyId, useName } from '../../app/company';
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
import { query } from '../../lib/format';
import { ReportFilters, useReportRange } from './ReportFilters';

export function LedgerPage() {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const { accountId } = useParams();
  const name = useName();
  const [range] = useReportRange();
  const params = { from: range.from, to: range.to, branchId: range.branchId };
  const ledger = useQuery({
    queryKey: ['ledger', companyId, accountId, params],
    queryFn: () =>
      request<AccountLedger>(`/companies/${companyId}/reports/ledger/${accountId}${query(params)}`),
  });

  return (
    <>
      <PageHeader
        title={
          ledger.data
            ? `${t('reports.ledger')}: ${ledger.data.code} · ${name(ledger.data.name)}`
            : t('reports.ledger')
        }
      >
        <Link to={`/c/${companyId}/reports${query(params)}`} className={secondaryButtonClass}>
          {t('reports.trialBalance')}
        </Link>
      </PageHeader>
      <ReportFilters />
      {ledger.isPending ? (
        <Loading />
      ) : ledger.error ? (
        <ErrorText error={ledger.error} />
      ) : (
        <Card className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>{t('common.date')}</th>
                <th className={thClass}>{t('journals.number')}</th>
                <th className={thClass}>{t('common.description')}</th>
                <th className={thClass}>{t('common.reference')}</th>
                <th className={`${thClass} text-end`}>{t('common.debit')}</th>
                <th className={`${thClass} text-end`}>{t('common.credit')}</th>
                <th className={`${thClass} text-end`}>{t('common.balance')}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="font-semibold">
                <td className={tdClass} colSpan={6}>
                  {t('reports.openingBalance')}
                </td>
                <td className={numClass}>
                  <Amount value={ledger.data.opening} />
                </td>
              </tr>
              {ledger.data.rows.map((row, index) => (
                <tr key={`${row.journalId}-${index}`}>
                  <td className={`${tdClass} tabular-nums`} dir="ltr">
                    {row.date}
                  </td>
                  <td className={`${tdClass} tabular-nums`}>
                    <Link
                      className="underline-offset-2 hover:underline"
                      to={`/c/${companyId}/journals/${row.journalId}`}
                    >
                      {row.number}
                    </Link>
                  </td>
                  <td className={tdClass}>{row.description}</td>
                  <td className={tdClass} dir="auto">
                    {row.reference}
                  </td>
                  <td className={numClass}>
                    <Amount value={row.debit} />
                  </td>
                  <td className={numClass}>
                    <Amount value={row.credit} />
                  </td>
                  <td className={numClass}>
                    <Amount value={row.balance} />
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-50 font-bold">
                <td className={tdClass} colSpan={6}>
                  {t('reports.closingBalance')}
                </td>
                <td className={numClass}>
                  <Amount value={ledger.data.closing} />
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
