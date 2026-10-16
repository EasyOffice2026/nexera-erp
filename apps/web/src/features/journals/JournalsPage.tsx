import {
  type JournalStatus,
  type JournalSummary,
  journalStatuses,
  type Page,
} from '@nexera/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useCompanyId } from '../../app/company';
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
import { useCan } from '../auth/auth-context';

const PAGE_SIZE = 50;

export function JournalsPage() {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const canWrite = useCan('journals.write');
  const [params, setParams] = useSearchParams();
  const status = journalStatuses.find((value) => value === params.get('status'));
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const search = params.get('search') ?? '';

  const journals = useQuery({
    queryKey: ['journals', companyId, status, page, search],
    queryFn: () =>
      request<Page<JournalSummary>>(
        `/companies/${companyId}/journals${query({ status, page, pageSize: PAGE_SIZE, search })}`,
      ),
  });

  function update(next: { status?: JournalStatus | ''; page?: number; search?: string }) {
    const merged = { status: status ?? '', page, search, ...next };
    const values: Record<string, string> = {};
    if (merged.status) values.status = merged.status;
    if (merged.search) values.search = merged.search;
    if (merged.page > 1) values.page = String(merged.page);
    setParams(values, { replace: true });
  }

  const pages = journals.data ? Math.max(1, Math.ceil(journals.data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <PageHeader title={t('journals.title')}>
        <input
          type="search"
          aria-label={t('common.search')}
          placeholder={t('common.search')}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
          defaultValue={search}
          onKeyDown={(event) => {
            if (event.key === 'Enter') update({ search: event.currentTarget.value, page: 1 });
          }}
        />
        <select
          aria-label={t('common.status')}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          value={status ?? ''}
          onChange={(e) => update({ status: e.target.value as JournalStatus | '', page: 1 })}
        >
          <option value="">{t('common.all')}</option>
          {journalStatuses.map((value) => (
            <option key={value} value={value}>
              {t(`journalStatus.${value}`)}
            </option>
          ))}
        </select>
        {canWrite && (
          <Link to={`/c/${companyId}/journals/new`} className={secondaryButtonClass}>
            {t('journals.new')}
          </Link>
        )}
      </PageHeader>
      {journals.isPending ? (
        <Loading />
      ) : journals.error ? (
        <ErrorText error={journals.error} />
      ) : journals.data.items.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">{t('journals.empty')}</p>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>{t('journals.number')}</th>
                <th className={thClass}>{t('common.date')}</th>
                <th className={thClass}>{t('common.description')}</th>
                <th className={thClass}>{t('common.reference')}</th>
                <th className={thClass}>{t('journals.source')}</th>
                <th className={thClass}>{t('common.status')}</th>
                <th className={`${thClass} text-end`}>{t('journals.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {journals.data.items.map((journal) => (
                <tr key={journal.id} className="hover:bg-slate-50">
                  <td className={`${tdClass} tabular-nums`}>
                    <Link
                      className="font-medium underline-offset-2 hover:underline"
                      to={`/c/${companyId}/journals/${journal.id}`}
                    >
                      {journal.number ?? t('journals.draft')}
                    </Link>
                  </td>
                  <td className={`${tdClass} tabular-nums`} dir="ltr">
                    {journal.date}
                  </td>
                  <td className={tdClass}>{journal.description}</td>
                  <td className={tdClass} dir="auto">
                    {journal.reference}
                  </td>
                  <td className={tdClass}>{t(`journalSource.${journal.source}`)}</td>
                  <td className={tdClass}>
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        journal.status === 'POSTED'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {t(`journalStatus.${journal.status}`)}
                    </span>
                  </td>
                  <td className={numClass}>
                    <Amount value={journal.totalDebit} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex items-center justify-end gap-2 text-sm">
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={page <= 1}
              onClick={() => update({ page: page - 1 })}
            >
              {t('common.previous')}
            </button>
            <span>{t('common.pageOf', { page, pages })}</span>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={page >= pages}
              onClick={() => update({ page: page + 1 })}
            >
              {t('common.next')}
            </button>
          </div>
        </Card>
      )}
    </>
  );
}
