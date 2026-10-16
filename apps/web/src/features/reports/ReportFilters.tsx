import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useBranches, useCompanyId, useName } from '../../app/company';
import { Field, inputClass } from '../../components/ui';
import { today } from '../../lib/format';

export const presets = [
  'thisMonth',
  'lastMonth',
  'thisQuarter',
  'lastQuarter',
  'yearToDate',
  'lastYear',
] as const;
export type Preset = (typeof presets)[number];

const iso = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);

// The from and to dates of a ready-made period, counted from the given day.
export function presetRange(preset: Preset, on: string): { from: string; to: string } {
  const year = Number(on.slice(0, 4));
  const month = Number(on.slice(5, 7)) - 1;
  const quarter = Math.floor(month / 3) * 3;
  switch (preset) {
    case 'thisMonth':
      return { from: iso(year, month, 1), to: iso(year, month + 1, 0) };
    case 'lastMonth':
      return { from: iso(year, month - 1, 1), to: iso(year, month, 0) };
    case 'thisQuarter':
      return { from: iso(year, quarter, 1), to: iso(year, quarter + 3, 0) };
    case 'lastQuarter':
      return { from: iso(year, quarter - 3, 1), to: iso(year, quarter, 0) };
    case 'yearToDate':
      return { from: iso(year, 0, 1), to: on };
    case 'lastYear':
      return { from: iso(year - 1, 0, 1), to: iso(year - 1, 11, 31) };
  }
}

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

export function ReportFilters({
  asOfOnly = false,
  withBranch = true,
  children,
}: {
  asOfOnly?: boolean;
  withBranch?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const branches = useBranches(companyId);
  const name = useName();
  const [range, update] = useReportRange();

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
      {!asOfOnly && (
        <Field label={t('reports.preset')}>
          <select
            className={inputClass}
            value={
              presets.find((preset) => {
                const r = presetRange(preset, today());
                return r.from === range.from && r.to === range.to;
              }) ?? ''
            }
            onChange={(e) => {
              const preset = presets.find((value) => value === e.target.value);
              if (preset) update(presetRange(preset, today()));
            }}
          >
            <option value="">{t('reports.presets.custom')}</option>
            {presets.map((preset) => (
              <option key={preset} value={preset}>
                {t(`reports.presets.${preset}`)}
              </option>
            ))}
          </select>
        </Field>
      )}
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
      {withBranch && (
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
      )}
      {children}
    </div>
  );
}
