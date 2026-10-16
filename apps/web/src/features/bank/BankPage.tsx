import {
  applyMapping,
  type BankAccountSummary,
  type BankCandidate,
  type BankImportResult,
  type BankLine,
  type BankMapping,
  type BankReconciliation,
  type BankRule,
  bankDirections,
  guessMapping,
  kuwaitiBanks,
  type Page,
} from '@nexera/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useAccounts, useBranches, useCompanyId, useName } from '../../app/company';
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
  secondaryButtonClass,
  tableClass,
  tdClass,
  thClass,
} from '../../components/ui';
import { request } from '../../lib/api';
import { query, today } from '../../lib/format';
import { readStatementFile } from '../../lib/statement-file';

const tabs = ['lines', 'import', 'rules', 'reconciliation'] as const;
type Tab = (typeof tabs)[number];

function useBankBase() {
  const companyId = useCompanyId();
  return { companyId, base: `/companies/${companyId}/bank` };
}

function useInvalidate() {
  const client = useQueryClient();
  const { companyId } = useBankBase();
  return () => client.invalidateQueries({ queryKey: ['bank', companyId] });
}

function AccountSelect({
  value,
  onChange,
  exclude,
}: {
  value: string;
  onChange: (value: string) => void;
  exclude?: string;
}) {
  const { t } = useTranslation();
  const { companyId } = useBankBase();
  const accounts = useAccounts(companyId);
  const name = useName();
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('bank.chooseAccount')}</option>
      {(accounts.data ?? [])
        .filter((row) => row.isPostable && row.isActive && row.id !== exclude)
        .map((row) => (
          <option key={row.id} value={row.id}>
            {row.code} · {name(row.name)}
          </option>
        ))}
    </select>
  );
}

function BranchSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  const { companyId } = useBankBase();
  const branches = useBranches(companyId);
  const name = useName();
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('bank.noBranch')}</option>
      {(branches.data ?? []).map((row) => (
        <option key={row.id} value={row.id}>
          {row.code} · {name(row.name)}
        </option>
      ))}
    </select>
  );
}

function LinkBankForm({ linked, onDone }: { linked: string[]; onDone: (id: string) => void }) {
  const { t } = useTranslation();
  const { companyId, base } = useBankBase();
  const accounts = useAccounts(companyId);
  const name = useName();
  const invalidate = useInvalidate();
  const [form, setForm] = useState({
    accountId: '',
    bankName: '',
    accountNumber: '',
    openingBalance: '0',
  });
  const create = useMutation({
    mutationFn: () =>
      request<BankAccountSummary>(`${base}/accounts`, { method: 'POST', body: form }),
    onSuccess: async (bank) => {
      await invalidate();
      onDone(bank.id);
    },
  });
  const choices = (accounts.data ?? []).filter(
    (row) => row.subtype === 'bank' && row.isPostable && !linked.includes(row.id),
  );
  return (
    <Card className="mb-4 p-4">
      <h2 className="mb-3 font-semibold">{t('bank.linkTitle')}</h2>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label={t('bank.glAccount')}>
          <select
            className={inputClass}
            required
            value={form.accountId}
            onChange={(e) => setForm({ ...form, accountId: e.target.value })}
          >
            <option value="">{t('bank.chooseAccount')}</option>
            {choices.map((row) => (
              <option key={row.id} value={row.id}>
                {row.code} · {name(row.name)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('bank.bankName')}>
          <input
            className={inputClass}
            list="kuwaiti-banks"
            required
            value={form.bankName}
            onChange={(e) => setForm({ ...form, bankName: e.target.value })}
          />
          <datalist id="kuwaiti-banks">
            {kuwaitiBanks.map((bank) => (
              <option key={bank} value={bank} />
            ))}
          </datalist>
        </Field>
        <Field label={t('bank.accountNumber')}>
          <input
            className={inputClass}
            value={form.accountNumber}
            onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
          />
        </Field>
        <Field label={t('bank.openingBalance')}>
          <input
            className={inputClass}
            dir="ltr"
            value={form.openingBalance}
            onChange={(e) => setForm({ ...form, openingBalance: e.target.value })}
          />
        </Field>
        <button type="submit" className={buttonClass} disabled={create.isPending}>
          {t('bank.link')}
        </button>
      </form>
      <p className="mt-2 text-xs text-slate-500">{t('bank.openingHint')}</p>
      <div className="mt-2">
        <ErrorText error={create.error} />
      </div>
    </Card>
  );
}

function ImportTab({ bank }: { bank: BankAccountSummary }) {
  const { t } = useTranslation();
  const { base } = useBankBase();
  const invalidate = useInvalidate();
  const [file, setFile] = useState<{ name: string; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState<BankMapping | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const upload = useMutation({
    mutationFn: () =>
      request<BankImportResult>(`${base}/accounts/${bank.id}/statements`, {
        method: 'POST',
        body: { fileName: file!.name, rows: file!.rows, mapping },
      }),
    onSuccess: () => invalidate(),
  });

  async function choose(chosen: File | undefined) {
    setReadError(null);
    upload.reset();
    if (!chosen) return;
    try {
      const rows = await readStatementFile(chosen);
      setFile({ name: chosen.name, rows });
      setMapping(
        bank.mapping ??
          guessMapping(rows) ?? {
            headerRow: 0,
            date: 0,
            dateOrder: 'DMY',
            description: 1,
            reference: null,
            amountMode: 'signed',
            amount: 2,
            moneyOut: null,
            moneyIn: null,
            balance: null,
            negate: false,
          },
      );
    } catch (error) {
      setReadError(error);
      setFile(null);
    }
  }

  const headings = file && mapping ? (file.rows[mapping.headerRow] ?? []) : [];
  const width = file ? Math.max(0, ...file.rows.slice(0, 50).map((row) => row.length)) : 0;
  const columnOptions = Array.from({ length: width }, (_, index) => ({
    index,
    label: `${index + 1}${headings[index] ? ` · ${headings[index]}` : ''}`,
  }));
  const parsed = file && mapping ? applyMapping(file.rows, mapping) : null;

  const columnField = (
    key: 'date' | 'description' | 'reference' | 'amount' | 'moneyOut' | 'moneyIn' | 'balance',
    optional = false,
  ) => (
    <Field label={t(`bank.columns.${key}`)}>
      <select
        className={inputClass}
        value={mapping?.[key] ?? ''}
        onChange={(e) =>
          setMapping({ ...mapping!, [key]: e.target.value === '' ? null : Number(e.target.value) })
        }
      >
        {optional && <option value="">—</option>}
        {columnOptions.map((option) => (
          <option key={option.index} value={option.index}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <p className="mb-3 text-sm text-slate-600">{t('bank.importIntro')}</p>
        <input
          type="file"
          accept=".xlsx,.csv,.txt"
          onChange={(e) => void choose(e.target.files?.[0])}
        />
        {bank.mapping && <p className="mt-2 text-xs text-slate-500">{t('bank.savedMapping')}</p>}
        <ErrorText error={readError} />
      </Card>
      {file && mapping && (
        <Card className="p-4">
          <h2 className="mb-3 font-semibold">{t('bank.mappingTitle')}</h2>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Field label={t('bank.headerRow')}>
              <input
                type="number"
                min={0}
                className={inputClass}
                value={mapping.headerRow + 1}
                onChange={(e) => setMapping({ ...mapping, headerRow: Number(e.target.value) - 1 })}
              />
            </Field>
            {columnField('date')}
            <Field label={t('bank.dateOrder')}>
              <select
                className={inputClass}
                value={mapping.dateOrder}
                onChange={(e) =>
                  setMapping({ ...mapping, dateOrder: e.target.value as BankMapping['dateOrder'] })
                }
              >
                <option value="DMY">{t('bank.dateOrders.DMY')}</option>
                <option value="MDY">{t('bank.dateOrders.MDY')}</option>
                <option value="YMD">{t('bank.dateOrders.YMD')}</option>
              </select>
            </Field>
            {columnField('description')}
            {columnField('reference', true)}
            <Field label={t('bank.amountMode')}>
              <select
                className={inputClass}
                value={mapping.amountMode}
                onChange={(e) => {
                  const mode = e.target.value as BankMapping['amountMode'];
                  setMapping({
                    ...mapping,
                    amountMode: mode,
                    amount: mode === 'signed' ? (mapping.amount ?? 0) : null,
                    moneyOut: mode === 'split' ? (mapping.moneyOut ?? 0) : null,
                    moneyIn: mode === 'split' ? (mapping.moneyIn ?? 0) : null,
                  });
                }}
              >
                <option value="split">{t('bank.amountModes.split')}</option>
                <option value="signed">{t('bank.amountModes.signed')}</option>
              </select>
            </Field>
            {mapping.amountMode === 'signed' ? (
              columnField('amount')
            ) : (
              <>
                {columnField('moneyOut')}
                {columnField('moneyIn')}
              </>
            )}
            {columnField('balance', true)}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={mapping.negate}
                onChange={(e) => setMapping({ ...mapping, negate: e.target.checked })}
              />
              {t('bank.negate')}
            </label>
          </div>
        </Card>
      )}
      {parsed && (
        <Card className="overflow-x-auto">
          <div className="flex flex-wrap items-center gap-3 p-4">
            <p className="text-sm">
              {t('bank.previewSummary', {
                lines: parsed.lines.length,
                skipped: parsed.skipped.length,
              })}
            </p>
            <button
              type="button"
              className={`${buttonClass} ms-auto`}
              disabled={parsed.lines.length === 0 || upload.isPending}
              onClick={() => upload.mutate()}
            >
              {t('bank.importButton')}
            </button>
          </div>
          <div className="px-4">
            <ErrorText error={upload.error} />
            {upload.data && (
              <p className="mb-3 rounded-md bg-green-50 p-3 text-sm text-green-800">
                {t('bank.importResult', {
                  imported: upload.data.imported,
                  duplicates: upload.data.duplicates,
                  autoMatched: upload.data.autoMatched,
                  ruleJournals: upload.data.ruleJournals,
                })}
              </p>
            )}
          </div>
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>{t('bank.row')}</th>
                <th className={thClass}>{t('bank.columns.date')}</th>
                <th className={thClass}>{t('bank.columns.description')}</th>
                <th className={thClass}>{t('bank.columns.reference')}</th>
                <th className={`${thClass} text-end`}>{t('bank.columns.amount')}</th>
                <th className={`${thClass} text-end`}>{t('bank.columns.balance')}</th>
              </tr>
            </thead>
            <tbody>
              {parsed.lines.slice(0, 15).map((line) => (
                <tr key={line.row}>
                  <td className={tdClass}>{line.row}</td>
                  <td className={tdClass}>{line.date}</td>
                  <td className={tdClass}>{line.description}</td>
                  <td className={tdClass}>{line.reference}</td>
                  <td className={numClass}>
                    <Amount value={line.amount} />
                  </td>
                  <td className={numClass}>{line.balance && <Amount value={line.balance} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function LineActions({ bank, line }: { bank: BankAccountSummary; line: BankLine }) {
  const { t } = useTranslation();
  const { base } = useBankBase();
  const invalidate = useInvalidate();
  const [form, setForm] = useState({ accountId: '', branchId: '', description: '' });
  const path = `${base}/accounts/${bank.id}/lines/${line.id}`;
  const candidates = useQuery({
    queryKey: ['bank', useBankBase().companyId, 'candidates', line.id],
    queryFn: () => request<BankCandidate[]>(`${path}/candidates`),
  });
  const match = useMutation({
    mutationFn: (journalLineId: string) =>
      request<BankLine>(`${path}/match`, { method: 'POST', body: { journalLineId } }),
    onSuccess: () => invalidate(),
  });
  const post = useMutation({
    mutationFn: () =>
      request<BankLine>(`${path}/journal`, {
        method: 'POST',
        body: {
          accountId: form.accountId,
          branchId: form.branchId || null,
          ...(form.description ? { description: form.description } : {}),
        },
      }),
    onSuccess: () => invalidate(),
  });
  return (
    <div className="space-y-3 bg-slate-50 p-3">
      <div>
        <h3 className="mb-1 text-sm font-semibold">{t('bank.suggestions')}</h3>
        {candidates.isPending && <Loading />}
        {candidates.data?.length === 0 && (
          <p className="text-sm text-slate-500">{t('bank.noSuggestions')}</p>
        )}
        <ul className="space-y-1">
          {candidates.data?.map((row) => (
            <li key={row.journalLineId} className="flex flex-wrap items-center gap-3 text-sm">
              <span>{row.date}</span>
              <span>#{row.journalNumber}</span>
              <span className="text-slate-700">{row.description}</span>
              <span className="text-slate-500">{row.reference}</span>
              <Amount value={row.amount} />
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={match.isPending}
                onClick={() => match.mutate(row.journalLineId)}
              >
                {t('bank.match')}
              </button>
            </li>
          ))}
        </ul>
        <ErrorText error={match.error} />
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          post.mutate();
        }}
      >
        <Field label={t('bank.otherAccount')}>
          <AccountSelect
            value={form.accountId}
            exclude={bank.accountId}
            onChange={(accountId) => setForm({ ...form, accountId })}
          />
        </Field>
        <Field label={t('bank.branch')}>
          <BranchSelect
            value={form.branchId}
            onChange={(branchId) => setForm({ ...form, branchId })}
          />
        </Field>
        <Field label={t('bank.journalDescription')}>
          <input
            className={inputClass}
            placeholder={line.description}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <button type="submit" className={buttonClass} disabled={!form.accountId || post.isPending}>
          {t('bank.createJournal')}
        </button>
      </form>
      <ErrorText error={post.error} />
    </div>
  );
}

function LinesTab({ bank }: { bank: BankAccountSummary }) {
  const { t } = useTranslation();
  const { companyId, base } = useBankBase();
  const invalidate = useInvalidate();
  const [status, setStatus] = useState<'' | 'matched' | 'unmatched'>('unmatched');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const lines = useQuery({
    queryKey: ['bank', companyId, 'lines', bank.id, status, page],
    queryFn: () =>
      request<Page<BankLine>>(
        `${base}/accounts/${bank.id}/lines${query({ status: status || undefined, page, pageSize: 50 })}`,
      ),
  });
  const auto = useMutation({
    mutationFn: () =>
      request<{ matched: number }>(`${base}/accounts/${bank.id}/auto-match`, { method: 'POST' }),
    onSuccess: () => invalidate(),
  });
  const rules = useMutation({
    mutationFn: () =>
      request<{ created: number }>(`${base}/accounts/${bank.id}/apply-rules`, { method: 'POST' }),
    onSuccess: () => invalidate(),
  });
  const unmatch = useMutation({
    mutationFn: (id: string) =>
      request<BankLine>(`${base}/accounts/${bank.id}/lines/${id}/unmatch`, { method: 'POST' }),
    onSuccess: () => invalidate(),
  });
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label={t('bank.status')}>
          <select
            className={inputClass}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status);
              setPage(1);
            }}
          >
            <option value="unmatched">{t('bank.statuses.unmatched')}</option>
            <option value="matched">{t('bank.statuses.matched')}</option>
            <option value="">{t('bank.statuses.all')}</option>
          </select>
        </Field>
        <div className="ms-auto flex gap-2">
          <button type="button" className={secondaryButtonClass} onClick={() => auto.mutate()}>
            {t('bank.autoMatch')}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={() => rules.mutate()}>
            {t('bank.applyRules')}
          </button>
        </div>
      </div>
      {auto.data && (
        <p className="mb-2 text-sm text-green-800">{t('bank.autoMatched', auto.data)}</p>
      )}
      {rules.data && (
        <p className="mb-2 text-sm text-green-800">{t('bank.rulesApplied', rules.data)}</p>
      )}
      <ErrorText error={auto.error ?? rules.error ?? unmatch.error} />
      {lines.isPending && <Loading />}
      {lines.error && <ErrorText error={lines.error} />}
      {lines.data && (
        <Card className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>{t('bank.columns.date')}</th>
                <th className={thClass}>{t('bank.columns.description')}</th>
                <th className={thClass}>{t('bank.columns.reference')}</th>
                <th className={`${thClass} text-end`}>{t('bank.columns.amount')}</th>
                <th className={thClass}>{t('bank.status')}</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody>
              {lines.data.items.length === 0 && (
                <tr>
                  <td className={tdClass} colSpan={6}>
                    {t('bank.noLines')}
                  </td>
                </tr>
              )}
              {lines.data.items.map((line) => [
                <tr key={line.id}>
                  <td className={tdClass}>{line.date}</td>
                  <td className={tdClass}>{line.description}</td>
                  <td className={tdClass}>{line.reference}</td>
                  <td className={numClass}>
                    <Amount value={line.amount} />
                  </td>
                  <td className={tdClass}>
                    {line.status === 'matched' ? (
                      <Link
                        className="text-blue-700 underline"
                        to={`/c/${companyId}/journals/${line.journalId}`}
                      >
                        {t('bank.matchedTo', { number: line.journalNumber })}
                        {line.ruleName ? ` · ${line.ruleName}` : ''}
                      </Link>
                    ) : (
                      <span className="text-amber-700">{t('bank.statuses.unmatched')}</span>
                    )}
                    {line.locked && (
                      <span className="ms-2 text-xs text-slate-500">{t('bank.locked')}</span>
                    )}
                  </td>
                  <td className={`${tdClass} text-end`}>
                    {!line.locked && line.status === 'unmatched' && (
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        onClick={() => setOpen(open === line.id ? null : line.id)}
                      >
                        {t('bank.resolve')}
                      </button>
                    )}
                    {!line.locked && line.status === 'matched' && (
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        onClick={() => unmatch.mutate(line.id)}
                      >
                        {t('bank.unmatch')}
                      </button>
                    )}
                  </td>
                </tr>,
                open === line.id && (
                  <tr key={`${line.id}-actions`}>
                    <td colSpan={6}>
                      <LineActions bank={bank} line={line} />
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
          {lines.data.total > lines.data.pageSize && (
            <div className="flex items-center gap-2 p-3 text-sm">
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                {t('bank.previous')}
              </button>
              <span>
                {page} / {Math.ceil(lines.data.total / lines.data.pageSize)}
              </span>
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={page * lines.data.pageSize >= lines.data.total}
                onClick={() => setPage(page + 1)}
              >
                {t('bank.next')}
              </button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function RulesTab({ bank }: { bank: BankAccountSummary }) {
  const { t } = useTranslation();
  const { companyId, base } = useBankBase();
  const invalidate = useInvalidate();
  const empty = {
    name: '',
    contains: '',
    direction: 'ANY',
    accountId: '',
    branchId: '',
    onlyThisBank: false,
  };
  const [form, setForm] = useState(empty);
  const rules = useQuery({
    queryKey: ['bank', companyId, 'rules'],
    queryFn: () => request<BankRule[]>(`${base}/rules`),
  });
  const create = useMutation({
    mutationFn: () =>
      request<BankRule>(`${base}/rules`, {
        method: 'POST',
        body: {
          name: form.name,
          contains: form.contains,
          direction: form.direction,
          accountId: form.accountId,
          branchId: form.branchId || null,
          bankAccountId: form.onlyThisBank ? bank.id : null,
        },
      }),
    onSuccess: async () => {
      setForm(empty);
      await invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => request<void>(`${base}/rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidate(),
  });
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <p className="mb-3 text-sm text-slate-600">{t('bank.rulesIntro')}</p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label={t('bank.ruleName')}>
            <input
              className={inputClass}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label={t('bank.contains')}>
            <input
              className={inputClass}
              required
              minLength={2}
              value={form.contains}
              onChange={(e) => setForm({ ...form, contains: e.target.value })}
            />
          </Field>
          <Field label={t('bank.direction')}>
            <select
              className={inputClass}
              value={form.direction}
              onChange={(e) => setForm({ ...form, direction: e.target.value })}
            >
              {bankDirections.map((direction) => (
                <option key={direction} value={direction}>
                  {t(`bank.directions.${direction}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('bank.otherAccount')}>
            <AccountSelect
              value={form.accountId}
              exclude={bank.accountId}
              onChange={(accountId) => setForm({ ...form, accountId })}
            />
          </Field>
          <Field label={t('bank.branch')}>
            <BranchSelect
              value={form.branchId}
              onChange={(branchId) => setForm({ ...form, branchId })}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.onlyThisBank}
              onChange={(e) => setForm({ ...form, onlyThisBank: e.target.checked })}
            />
            {t('bank.onlyThisBank')}
          </label>
          <button
            type="submit"
            className={buttonClass}
            disabled={!form.accountId || create.isPending}
          >
            {t('bank.addRule')}
          </button>
        </form>
        <ErrorText error={create.error ?? remove.error} />
      </Card>
      {rules.data && (
        <Card className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>{t('bank.ruleName')}</th>
                <th className={thClass}>{t('bank.contains')}</th>
                <th className={thClass}>{t('bank.direction')}</th>
                <th className={thClass}>{t('bank.otherAccount')}</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody>
              {rules.data.map((rule) => (
                <tr key={rule.id}>
                  <td className={tdClass}>{rule.name}</td>
                  <td className={tdClass}>{rule.contains}</td>
                  <td className={tdClass}>{t(`bank.directions.${rule.direction}`)}</td>
                  <td className={tdClass}>{rule.accountCode}</td>
                  <td className={`${tdClass} text-end`}>
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      onClick={() => remove.mutate(rule.id)}
                    >
                      {t('bank.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function ReconciliationTab({ bank }: { bank: BankAccountSummary }) {
  const { t } = useTranslation();
  const { companyId, base } = useBankBase();
  const invalidate = useInvalidate();
  const [asOf, setAsOf] = useState(bank.lastLineDate ?? today());
  const rec = useQuery({
    queryKey: ['bank', companyId, 'reconciliation', bank.id, asOf],
    queryFn: () =>
      request<BankReconciliation>(`${base}/accounts/${bank.id}/reconciliation${query({ asOf })}`),
  });
  const lock = useMutation({
    mutationFn: () =>
      request<BankReconciliation>(`${base}/accounts/${bank.id}/reconciliations`, {
        method: 'POST',
        body: { asOf },
      }),
    onSuccess: () => invalidate(),
  });
  const row = (label: string, value: string, strong = false) => (
    <tr className={strong ? 'font-semibold' : ''}>
      <td className={tdClass}>{label}</td>
      <td className={numClass}>
        <Amount value={value} />
      </td>
    </tr>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <Field label={t('bank.asOf')}>
          <input
            type="date"
            className={inputClass}
            value={asOf}
            onChange={(e) => e.target.value && setAsOf(e.target.value)}
          />
        </Field>
        <button type="button" className={secondaryButtonClass} onClick={() => window.print()}>
          {t('reports.print')}
        </button>
        {rec.data && (
          <button
            type="button"
            className={`${buttonClass} ms-auto`}
            disabled={!rec.data.canLock || lock.isPending}
            onClick={() => lock.mutate()}
          >
            {t('bank.lock')}
          </button>
        )}
      </div>
      <ErrorText error={lock.error} />
      {rec.isPending && <Loading />}
      {rec.error && <ErrorText error={rec.error} />}
      {rec.data && (
        <>
          <Card className="overflow-x-auto">
            <h2 className="px-4 pt-4 font-semibold">
              {bank.bankName} · {t('bank.asOf')} {rec.data.asOf}
            </h2>
            <table className={tableClass}>
              <tbody>
                {row(t('bank.bookBalance'), rec.data.bookBalance)}
                {row(t('bank.addBankOnly'), rec.data.unmatchedBankTotal)}
                {row(
                  t('bank.lessBookOnly'),
                  rec.data.unmatchedBookTotal.startsWith('-')
                    ? rec.data.unmatchedBookTotal.slice(1)
                    : `-${rec.data.unmatchedBookTotal}`,
                )}
                {row(t('bank.statementBalance'), rec.data.statementBalance, true)}
                {rec.data.bankBalanceColumn !== null &&
                  row(t('bank.bankColumn'), rec.data.bankBalanceColumn)}
                {row(t('bank.difference'), rec.data.difference, true)}
              </tbody>
            </table>
            <p className="p-4 text-sm">
              {rec.data.reconciledUntil && (
                <span className="me-3">
                  {t('bank.reconciledUntil', { date: rec.data.reconciledUntil })}
                </span>
              )}
              <span className={rec.data.canLock ? 'text-green-700' : 'text-amber-700'}>
                {rec.data.canLock ? t('bank.canLock') : t('bank.cannotLock')}
              </span>
            </p>
          </Card>
          <Card className="overflow-x-auto">
            <h2 className="px-4 pt-4 font-semibold">{t('bank.bankOnlyTitle')}</h2>
            <table className={tableClass}>
              <tbody>
                {rec.data.unmatchedBank.map((line) => (
                  <tr key={line.id}>
                    <td className={tdClass}>{line.date}</td>
                    <td className={tdClass}>{line.description}</td>
                    <td className={numClass}>
                      <Amount value={line.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card className="overflow-x-auto">
            <h2 className="px-4 pt-4 font-semibold">{t('bank.bookOnlyTitle')}</h2>
            <table className={tableClass}>
              <tbody>
                {rec.data.unmatchedBook.map((item) => (
                  <tr key={item.journalLineId}>
                    <td className={tdClass}>{item.date}</td>
                    <td className={tdClass}>
                      <Link
                        className="text-blue-700 underline"
                        to={`/c/${companyId}/journals/${item.journalId}`}
                      >
                        #{item.journalNumber}
                      </Link>{' '}
                      {item.description}
                    </td>
                    <td className={numClass}>
                      <Amount value={item.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

export function BankPage() {
  const { t } = useTranslation();
  const { companyId, base } = useBankBase();
  const [params, setParams] = useSearchParams();
  const [linking, setLinking] = useState(false);
  const banks = useQuery({
    queryKey: ['bank', companyId, 'accounts'],
    queryFn: () => request<BankAccountSummary[]>(`${base}/accounts`),
  });
  const tab: Tab = tabs.find((value) => value === params.get('tab')) ?? 'lines';
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };
  if (banks.isPending) return <Loading />;
  if (banks.error) return <ErrorText error={banks.error} />;
  const bank = banks.data.find((row) => row.id === params.get('bank')) ?? banks.data[0];

  return (
    <>
      <PageHeader title={t('bank.title')}>
        <button type="button" className={secondaryButtonClass} onClick={() => setLinking(!linking)}>
          {t('bank.linkTitle')}
        </button>
      </PageHeader>
      {(linking || banks.data.length === 0) && (
        <LinkBankForm
          linked={banks.data.map((row) => row.accountId)}
          onDone={(id) => {
            setLinking(false);
            set('bank', id);
          }}
        />
      )}
      {bank && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {banks.data.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => set('bank', row.id)}
                className={`rounded-lg border p-3 text-start text-sm ${
                  row.id === bank.id ? 'border-slate-900 bg-white' : 'border-slate-200 bg-slate-50'
                }`}
              >
                <div className="font-semibold">{row.bankName}</div>
                <div className="text-xs text-slate-500" dir="ltr">
                  {row.accountCode} {row.accountNumber}
                </div>
                <div className="mt-2 flex justify-between gap-2">
                  <span>{t('bank.bookBalance')}</span>
                  <Amount value={row.bookBalance} />
                </div>
                <div className="flex justify-between gap-2">
                  <span>{t('bank.statementBalance')}</span>
                  <Amount value={row.statementBalance} />
                </div>
                <div className="mt-1 text-xs text-amber-700">
                  {t('bank.unmatchedCount', { count: row.unmatchedCount })}
                </div>
              </button>
            ))}
          </div>
          <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-slate-200 p-1 print:hidden">
            {tabs.map((value) => (
              <button
                key={value}
                type="button"
                className={`rounded-md px-3 py-1 text-sm ${value === tab ? 'bg-white shadow-sm' : 'text-slate-700'}`}
                onClick={() => set('tab', value)}
              >
                {t(`bank.tabs.${value}`)}
              </button>
            ))}
          </div>
          {tab === 'lines' && <LinesTab key={bank.id} bank={bank} />}
          {tab === 'import' && <ImportTab key={bank.id} bank={bank} />}
          {tab === 'rules' && <RulesTab key={bank.id} bank={bank} />}
          {tab === 'reconciliation' && <ReconciliationTab key={bank.id} bank={bank} />}
        </>
      )}
    </>
  );
}
