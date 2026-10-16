import type { Branch, Brand, Company } from '@nexera/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useBranches, useBrands, useCompanies, useName } from '../../app/company';
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

function monthName(month: number, language: string): string {
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar-KW' : 'en-GB', { month: 'long' }).format(
    new Date(2000, month - 1, 1),
  );
}

function NewCompanyForm({ onCreated }: { onCreated: (company: Company) => void }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    en: '',
    ar: '',
    legalName: '',
    crNumber: '',
    fiscalYearEndMonth: 12,
    useTemplate: true,
  });
  const create = useMutation({
    mutationFn: () =>
      request<Company>('/companies', {
        method: 'POST',
        body: {
          name: { en: form.en, ar: form.ar },
          legalName: form.legalName,
          crNumber: form.crNumber,
          fiscalYearEndMonth: form.fiscalYearEndMonth,
          useTemplate: form.useTemplate,
        },
      }),
    onSuccess: async (company) => {
      await queryClient.invalidateQueries({ queryKey: ['companies'] });
      onCreated(company);
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <Card className="mb-4">
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.nameEn')}>
          <input
            required
            dir="ltr"
            className={inputClass}
            value={form.en}
            onChange={(e) => setForm({ ...form, en: e.target.value })}
          />
        </Field>
        <Field label={t('common.nameAr')}>
          <input
            required
            dir="rtl"
            className={inputClass}
            value={form.ar}
            onChange={(e) => setForm({ ...form, ar: e.target.value })}
          />
        </Field>
        <Field label={t('companies.legalName')}>
          <input
            required
            className={inputClass}
            value={form.legalName}
            onChange={(e) => setForm({ ...form, legalName: e.target.value })}
          />
        </Field>
        <Field label={t('companies.crNumber')}>
          <input
            required
            dir="ltr"
            className={inputClass}
            value={form.crNumber}
            onChange={(e) => setForm({ ...form, crNumber: e.target.value })}
          />
        </Field>
        <Field label={t('companies.fiscalYearEnd')}>
          <select
            className={inputClass}
            value={form.fiscalYearEndMonth}
            onChange={(e) => setForm({ ...form, fiscalYearEndMonth: Number(e.target.value) })}
          >
            {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => (
              <option key={month} value={month}>
                {monthName(month, i18n.language)}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 self-end text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.useTemplate}
            onChange={(e) => setForm({ ...form, useTemplate: e.target.checked })}
          />
          {t('companies.useTemplate')}
        </label>
        <div className="sm:col-span-2">
          <ErrorText error={create.error} />
        </div>
        <div className="sm:col-span-2">
          <button type="submit" className={buttonClass} disabled={create.isPending}>
            {t('common.create')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function BrandsAndBranches({ company }: { company: Company }) {
  const { t } = useTranslation();
  const name = useName();
  const queryClient = useQueryClient();
  const canManage = useCan('companies.manage');
  const brands = useBrands(company.id);
  const branches = useBranches(company.id);
  const [brand, setBrand] = useState({ en: '', ar: '' });
  const [branch, setBranch] = useState({ brandId: '', code: '', en: '', ar: '' });

  const addBrand = useMutation({
    mutationFn: () =>
      request<Brand>(`/companies/${company.id}/brands`, {
        method: 'POST',
        body: { name: brand },
      }),
    onSuccess: async () => {
      setBrand({ en: '', ar: '' });
      await queryClient.invalidateQueries({ queryKey: ['brands', company.id] });
    },
  });
  const addBranch = useMutation({
    mutationFn: () =>
      request<Branch>(`/companies/${company.id}/branches`, {
        method: 'POST',
        body: {
          brandId: branch.brandId || brands.data?.[0]?.id,
          code: branch.code,
          name: { en: branch.en, ar: branch.ar },
        },
      }),
    onSuccess: async () => {
      setBranch({ brandId: branch.brandId, code: '', en: '', ar: '' });
      await queryClient.invalidateQueries({ queryKey: ['branches', company.id] });
    },
  });

  const brandName = (id: string) => {
    const found = brands.data?.find((row) => row.id === id);
    return found ? name(found.name) : '';
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <h2 className="mb-3 font-semibold">{t('companies.brands')}</h2>
        {brands.isPending ? (
          <Loading />
        ) : (
          <ul className="mb-3 space-y-1 text-sm">
            {brands.data?.map((row) => (
              <li key={row.id}>{name(row.name)}</li>
            ))}
          </ul>
        )}
        {canManage && (
          <form
            className="grid gap-2 sm:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              addBrand.mutate();
            }}
          >
            <input
              required
              dir="ltr"
              placeholder={t('common.nameEn')}
              className={inputClass}
              value={brand.en}
              onChange={(e) => setBrand({ ...brand, en: e.target.value })}
            />
            <input
              required
              dir="rtl"
              placeholder={t('common.nameAr')}
              className={inputClass}
              value={brand.ar}
              onChange={(e) => setBrand({ ...brand, ar: e.target.value })}
            />
            <button type="submit" className={buttonClass} disabled={addBrand.isPending}>
              {t('companies.newBrand')}
            </button>
            <div className="sm:col-span-3">
              <ErrorText error={addBrand.error} />
            </div>
          </form>
        )}
      </Card>
      <Card>
        <h2 className="mb-3 font-semibold">{t('companies.branches')}</h2>
        {branches.isPending ? (
          <Loading />
        ) : (
          <table className={`${tableClass} mb-3`}>
            <thead>
              <tr>
                <th className={thClass}>{t('common.code')}</th>
                <th className={thClass}>{t('common.name')}</th>
                <th className={thClass}>{t('companies.brand')}</th>
              </tr>
            </thead>
            <tbody>
              {branches.data?.map((row) => (
                <tr key={row.id}>
                  <td className={tdClass} dir="ltr">
                    {row.code}
                  </td>
                  <td className={tdClass}>{name(row.name)}</td>
                  <td className={tdClass}>{brandName(row.brandId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canManage && (brands.data?.length ?? 0) > 0 && (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              addBranch.mutate();
            }}
          >
            <select
              aria-label={t('companies.brand')}
              className={inputClass}
              value={branch.brandId}
              onChange={(e) => setBranch({ ...branch, brandId: e.target.value })}
            >
              {brands.data?.map((row) => (
                <option key={row.id} value={row.id}>
                  {name(row.name)}
                </option>
              ))}
            </select>
            <input
              required
              dir="ltr"
              placeholder={t('common.code')}
              className={inputClass}
              value={branch.code}
              onChange={(e) => setBranch({ ...branch, code: e.target.value })}
            />
            <input
              required
              dir="ltr"
              placeholder={t('common.nameEn')}
              className={inputClass}
              value={branch.en}
              onChange={(e) => setBranch({ ...branch, en: e.target.value })}
            />
            <input
              required
              dir="rtl"
              placeholder={t('common.nameAr')}
              className={inputClass}
              value={branch.ar}
              onChange={(e) => setBranch({ ...branch, ar: e.target.value })}
            />
            <button type="submit" className={buttonClass} disabled={addBranch.isPending}>
              {t('companies.newBranch')}
            </button>
            <div className="sm:col-span-2">
              <ErrorText error={addBranch.error} />
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

export function CompaniesPage() {
  const { t, i18n } = useTranslation();
  const name = useName();
  const companies = useCompanies();
  const canManage = useCan('companies.manage');
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id') ?? companies.data?.[0]?.id;
  const selected = companies.data?.find((company) => company.id === selectedId);

  if (companies.isPending) return <Loading />;
  if (companies.error) return <ErrorText error={companies.error} />;

  return (
    <>
      <PageHeader title={t('companies.title')}>
        {canManage && (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => setCreating(!creating)}
          >
            {creating ? t('common.cancel') : t('companies.new')}
          </button>
        )}
      </PageHeader>
      {creating && (
        <NewCompanyForm
          onCreated={(company) => {
            setCreating(false);
            setParams({ id: company.id });
          }}
        />
      )}
      {companies.data.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">{t('companies.empty')}</p>
        </Card>
      ) : (
        <Card className="mb-4 overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>{t('common.name')}</th>
                <th className={thClass}>{t('companies.legalName')}</th>
                <th className={thClass}>{t('companies.crNumber')}</th>
                <th className={thClass}>{t('companies.fiscalYearEnd')}</th>
                <th className={thClass}>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {companies.data.map((company) => (
                <tr
                  key={company.id}
                  className={company.id === selectedId ? 'bg-slate-50' : undefined}
                >
                  <td className={tdClass}>
                    <button
                      type="button"
                      className="font-medium text-slate-900 underline-offset-2 hover:underline"
                      onClick={() => setParams({ id: company.id })}
                    >
                      {name(company.name)}
                    </button>
                  </td>
                  <td className={tdClass}>{company.legalName}</td>
                  <td className={tdClass} dir="ltr">
                    {company.crNumber}
                  </td>
                  <td className={tdClass}>
                    {monthName(company.fiscalYearEndMonth, i18n.language)}
                  </td>
                  <td className={tdClass}>
                    <Link className={secondaryButtonClass} to={`/c/${company.id}/journals`}>
                      {t('companies.open')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {selected ? (
        <BrandsAndBranches key={selected.id} company={selected} />
      ) : (
        companies.data.length > 0 && (
          <p className="text-sm text-slate-500">{t('companies.select')}</p>
        )
      )}
    </>
  );
}
