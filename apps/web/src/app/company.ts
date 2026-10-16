import type { Account, Branch, Brand, Company, FiscalYear, LocalizedName } from '@nexera/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { request } from '../lib/api';
import { nameIn } from '../lib/format';

export function useCompanyId(): string {
  const { companyId } = useParams();
  if (!companyId) throw new Error('This page needs a company in its address.');
  return companyId;
}

export function useCompanies() {
  return useQuery({ queryKey: ['companies'], queryFn: () => request<Company[]>('/companies') });
}

export function useAccounts(companyId: string) {
  return useQuery({
    queryKey: ['accounts', companyId],
    queryFn: () => request<Account[]>(`/companies/${companyId}/accounts`),
  });
}

export function useBrands(companyId: string) {
  return useQuery({
    queryKey: ['brands', companyId],
    queryFn: () => request<Brand[]>(`/companies/${companyId}/brands`),
  });
}

export function useBranches(companyId: string) {
  return useQuery({
    queryKey: ['branches', companyId],
    queryFn: () => request<Branch[]>(`/companies/${companyId}/branches`),
  });
}

export function useFiscalYears(companyId: string) {
  return useQuery({
    queryKey: ['fiscal-years', companyId],
    queryFn: () => request<FiscalYear[]>(`/companies/${companyId}/fiscal-years`),
  });
}

// The name in the current interface language.
export function useName(): (name: LocalizedName) => string {
  const { i18n } = useTranslation();
  return (name) => nameIn(name, i18n.language);
}
