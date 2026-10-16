import type { XbrlFact, XbrlPreview } from '@nexera/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useCompanyId } from '../../app/company';
import {
  Amount,
  buttonClass,
  Card,
  ErrorText,
  Field,
  inputClass,
  Loading,
  numClass,
  PageHeader,
  tableClass,
  tdClass,
  thClass,
} from '../../components/ui';
import { download, request } from '../../lib/api';
import { query } from '../../lib/format';

function useYearRange(): [
  { from: string; to: string },
  (key: 'from' | 'to', value: string) => void,
] {
  const [params, setParams] = useSearchParams();
  const year = new Date().getFullYear();
  const range = {
    from: params.get('from') ?? `${year}-01-01`,
    to: params.get('to') ?? `${year}-12-31`,
  };
  const update = (key: 'from' | 'to', value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };
  return [range, update];
}

function factRows(facts: XbrlFact[]) {
  const rows = new Map<
    string,
    { concept: string; instant: boolean; current?: string; prior?: string }
  >();
  for (const fact of facts) {
    const row = rows.get(fact.concept) ?? { concept: fact.concept, instant: fact.instant };
    row[fact.period] = fact.value;
    rows.set(fact.concept, row);
  }
  return [...rows.values()];
}

export function XbrlPage() {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const [range, update] = useYearRange();
  const path = `/companies/${companyId}/xbrl`;
  const preview = useQuery({
    queryKey: ['xbrl', companyId, range],
    queryFn: () => request<XbrlPreview>(`${path}/preview${query(range)}`),
  });
  const save = useMutation({
    mutationFn: (data: XbrlPreview) =>
      download(`${path}/instance${query(range)}`, `CR-${data.crNumber}_${data.to}.xbrl`),
  });

  return (
    <>
      <PageHeader title={t('xbrl.title')} />
      <p className="mb-4 max-w-3xl text-sm text-slate-600">{t('xbrl.intro')}</p>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label={t('xbrl.from')}>
          <input
            type="date"
            className={inputClass}
            value={range.from}
            onChange={(e) => e.target.value && update('from', e.target.value)}
          />
        </Field>
        <Field label={t('xbrl.to')}>
          <input
            type="date"
            className={inputClass}
            value={range.to}
            onChange={(e) => e.target.value && update('to', e.target.value)}
          />
        </Field>
        {preview.data && (
          <button
            type="button"
            className={`${buttonClass} ms-auto`}
            disabled={!preview.data.ready || save.isPending}
            onClick={() => save.mutate(preview.data)}
          >
            {t('xbrl.download')}
          </button>
        )}
      </div>
      <ErrorText error={save.error} />
      {preview.isPending && <Loading />}
      {preview.error && <ErrorText error={preview.error} />}
      {preview.data && <PreviewBody data={preview.data} />}
    </>
  );
}

function PreviewBody({ data }: { data: XbrlPreview }) {
  const { t } = useTranslation();
  const rows = factRows(data.facts);
  return (
    <div className="space-y-4">
      <Card>
        <dl className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-slate-500">{t('xbrl.legalName')}</dt>
            <dd className="font-medium">{data.legalName}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t('xbrl.crNumber')}</dt>
            <dd className="font-medium" dir="ltr">
              {data.crNumber}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">{t('xbrl.taxonomy')}</dt>
            <dd className="font-medium">
              {data.taxonomy.name} {data.taxonomy.version}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">{t('xbrl.status')}</dt>
            <dd className={`font-medium ${data.ready ? 'text-green-700' : 'text-red-700'}`}>
              {data.ready ? t('xbrl.ready') : t('xbrl.notReady')}
            </dd>
          </div>
        </dl>
      </Card>
      <Card>
        <h2 className="px-4 pt-4 font-semibold">{t('xbrl.checksTitle')}</h2>
        <ul className="divide-y divide-slate-100 p-4 text-sm">
          {data.checks.map((check) => (
            <li key={check.code} className="flex flex-wrap items-baseline gap-2 py-2">
              <span
                className={
                  check.ok
                    ? 'text-green-700'
                    : check.severity === 'error'
                      ? 'text-red-700'
                      : 'text-amber-700'
                }
              >
                {check.ok ? '✓' : check.severity === 'error' ? '✗' : '!'}
              </span>
              <span>{t(`xbrl.checks.${check.code}`)}</span>
              {!check.ok && (
                <span className="text-xs text-slate-500">
                  {check.severity === 'error' ? t('xbrl.mustFix') : t('xbrl.warning')}
                </span>
              )}
              {!check.ok && check.accounts.length > 0 && (
                <span className="w-full ps-5 text-xs text-slate-600" dir="ltr">
                  {check.accounts.join(', ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>{t('xbrl.element')}</th>
              <th className={`${thClass} text-end`}>
                {data.from} – {data.to}
              </th>
              {data.prior && (
                <th className={`${thClass} text-end`}>
                  {data.prior.from} – {data.prior.to}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.concept}>
                <td className={tdClass} dir="ltr">
                  {row.concept}
                </td>
                <td className={numClass}>
                  {row.current !== undefined && <Amount value={row.current} />}
                </td>
                {data.prior && (
                  <td className={numClass}>
                    {row.prior !== undefined && <Amount value={row.prior} />}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
