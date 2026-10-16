import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useBranches, useCompanyId, useName } from '../../app/company';
import { Field, inputClass } from '../../components/ui';
import { today } from '../../lib/format';

export interface ReportRange {
  from: string;
  to: string;
  branchId: string;
}

// The report filters live in the address, so a report can be bookmarked or shared.
export function useReportRange(): [ReportRange, (change: Partial<ReportRange>) => void] {
  const [params, setParams] = useSearchParams();
  const to = params.get('to') ?? today();
  const range = {
    from: params.get('from') ?? `${to.slice(0, 4)}-01-01`,
    to,
    branchId: params.get('branchId') ?? '',
  };
  const update = (change: Partial<ReportRange>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(change)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };
  return [range, update];
}

export function ReportFilters({ asOfOnly = false }: { asOfOnly?: boolean }) {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const branches = useBranches(companyId);
  const name = useName();
  const [range, update] = useReportRange();

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      {!asOfOnly && (
        <Field label={t('common.from')}>
          <input
            type="date"
            className={inputClass}
            value={range.from}
            onChange={(e) => update({ from: e.target.value })}
          />
        </Field>
      )}
      <Field label={asOfOnly ? t('common.asOf') : t('common.to')}>
        <input
          type="date"
          className={inputClass}
          value={range.to}
          onChange={(e) => update({ to: e.target.value })}
        />
      </Field>
      <Field label={t('common.branch')}>
        <select
          className={inputClass}
          value={range.branchId}
          onChange={(e) => update({ branchId: e.target.value })}
        >
          <option value="">{t('common.allBranches')}</option>
          {branches.data?.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {name(branch.name)}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}
