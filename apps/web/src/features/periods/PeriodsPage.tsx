import type { FiscalYear, Period, PeriodStatus } from '@nexera/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCompanyId, useFiscalYears } from '../../app/company';
import {
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
import { useCan } from '../auth/auth-context';

export function PeriodsPage() {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const queryClient = useQueryClient();
  const years = useFiscalYears(companyId);
  const canManage = useCan('periods.manage');
  const [startMonth, setStartMonth] = useState(`${new Date().getFullYear()}-01`);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['fiscal-years', companyId] });
  const create = useMutation({
    mutationFn: () =>
      request<FiscalYear>(`/companies/${companyId}/fiscal-years`, {
        method: 'POST',
        body: { startDate: `${startMonth}-01` },
      }),
    onSuccess: invalidate,
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: PeriodStatus }) =>
      request<Period>(`/companies/${companyId}/periods/${id}`, {
        method: 'PATCH',
        body: { status },
      }),
    onSuccess: invalidate,
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  if (years.isPending) return <Loading />;
  if (years.error) return <ErrorText error={years.error} />;

  return (
    <>
      <PageHeader title={t('periods.title')} />
      {canManage && (
        <Card className="mb-4">
          <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
            <Field label={t('periods.startMonth')}>
              <input
                type="month"
                required
                className={inputClass}
                value={startMonth}
                onChange={(e) => setStartMonth(e.target.value)}
              />
            </Field>
            <button type="submit" className={buttonClass} disabled={create.isPending}>
              {t('periods.newYear')}
            </button>
          </form>
          <div className="mt-3">
            <ErrorText error={create.error} />
          </div>
        </Card>
      )}
      <ErrorText error={setStatus.error} />
      {years.data.length === 0 && (
        <Card>
          <p className="text-sm text-slate-500">{t('periods.empty')}</p>
        </Card>
      )}
      {years.data.map((year) => (
        <Card key={year.id} className="mb-4 overflow-x-auto">
          <h2 className="mb-3 font-semibold">
            {year.name}{' '}
            <span className="text-sm font-normal text-slate-500">
              ({t(`periodStatus.${year.status}`)})
            </span>
          </h2>
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>{t('periods.period')}</th>
                <th className={thClass}>{t('common.from')}</th>
                <th className={thClass}>{t('common.to')}</th>
                <th className={thClass}>{t('common.status')}</th>
                {canManage && <th className={thClass}>{t('common.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {year.periods.map((period) => (
                <tr key={period.id}>
                  <td className={`${tdClass} tabular-nums`}>{period.number}</td>
                  <td className={`${tdClass} tabular-nums`} dir="ltr">
                    {period.startDate}
                  </td>
                  <td className={`${tdClass} tabular-nums`} dir="ltr">
                    {period.endDate}
                  </td>
                  <td className={tdClass}>
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        period.status === 'OPEN'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-slate-200 text-slate-700'
                      }`}
                    >
                      {t(`periodStatus.${period.status}`)}
                    </span>
                  </td>
                  {canManage && (
                    <td className={tdClass}>
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        disabled={setStatus.isPending}
                        onClick={() =>
                          setStatus.mutate({
                            id: period.id,
                            status: period.status === 'OPEN' ? 'CLOSED' : 'OPEN',
                          })
                        }
                      >
                        {period.status === 'OPEN' ? t('periods.close') : t('periods.reopen')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </>
  );
}
