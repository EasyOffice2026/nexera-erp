import type { AccountSubtype, Language } from '@nexera/shared';

// The statement line of each account subtype, in both languages.
const labels: Record<AccountSubtype, Record<Language, string>> = {
  cash: { en: 'Cash', ar: 'النقد' },
  bank: { en: 'Banks', ar: 'البنوك' },
  receivable: { en: 'Receivables', ar: 'الذمم المدينة' },
  inventory: { en: 'Inventories', ar: 'المخزون' },
  prepayment: { en: 'Prepayments', ar: 'المدفوعات المقدمة' },
  other_current_asset: { en: 'Other current assets', ar: 'أصول متداولة أخرى' },
  fixed_asset: { en: 'Property and equipment', ar: 'الممتلكات والمعدات' },
  accumulated_depreciation: { en: 'Accumulated depreciation', ar: 'مجمع الاستهلاك' },
  right_of_use_asset: { en: 'Right-of-use assets', ar: 'أصول حق الاستخدام' },
  other_non_current_asset: { en: 'Other non-current assets', ar: 'أصول غير متداولة أخرى' },
  payable: { en: 'Payables', ar: 'الذمم الدائنة' },
  accrued_liability: { en: 'Accrued liabilities', ar: 'المستحقات' },
  other_current_liability: { en: 'Other current liabilities', ar: 'خصوم متداولة أخرى' },
  lease_liability: { en: 'Lease liabilities', ar: 'التزامات الإيجار' },
  employee_benefits: { en: 'Employee end-of-service benefits', ar: 'مكافأة نهاية الخدمة' },
  other_non_current_liability: { en: 'Other non-current liabilities', ar: 'خصوم غير متداولة أخرى' },
  share_capital: { en: 'Share capital', ar: 'رأس المال' },
  reserve: { en: 'Reserves', ar: 'الاحتياطيات' },
  retained_earnings: { en: 'Retained earnings', ar: 'الأرباح المرحلة' },
  owner_current_account: { en: "Owners' current accounts", ar: 'الحسابات الجارية للشركاء' },
  sales: { en: 'Sales', ar: 'المبيعات' },
  sales_deduction: { en: 'Discounts and refunds', ar: 'الخصومات والمرتجعات' },
  other_income: { en: 'Other income', ar: 'إيرادات أخرى' },
  cost_of_sales: { en: 'Cost of sales', ar: 'تكلفة المبيعات' },
  operating_expense: { en: 'Operating expenses', ar: 'المصروفات التشغيلية' },
  depreciation: { en: 'Depreciation', ar: 'الاستهلاك' },
  finance_cost: { en: 'Finance costs', ar: 'تكاليف التمويل' },
  other_expense: { en: 'Other expenses', ar: 'مصروفات أخرى' },
};

export function subtypeLabel(subtype: string, language: string): string {
  const label = labels[subtype as AccountSubtype] as Record<Language, string> | undefined;
  if (!label) return subtype;
  return language === 'ar' ? label.ar : label.en;
}
