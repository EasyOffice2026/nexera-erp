import { fromFils, type Journal } from '@nexera/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { useAccounts, useBranches, useCompanyId, useName } from '../../app/company';
import {
  Amount,
  buttonClass,
  Card,
  dangerButtonClass,
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
import { filsOrZero, today } from '../../lib/format';
import { useCan } from '../auth/auth-context';

interface LineDraft {
  key: number;
  accountId: string;
  branchId: string;
  description: string;
  debit: string;
  credit: string;
}

let nextKey = 1;
const emptyLine = (): LineDraft => ({
  key: nextKey++,
  accountId: '',
  branchId: '',
  description: '',
  debit: '',
  credit: '',
});

const cellInput =
  'w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:ring-2 focus:ring-slate-400 focus:outline-none';

function JournalEditor({ journal }: { journal: Journal | undefined }) {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const name = useName();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canPost = useCan('journals.post');
  const accounts = useAccounts(companyId);
  const branches = useBranches(companyId);

  const [date, setDate] = useState(journal?.date ?? today());
  const [description, setDescription] = useState(journal?.description ?? '');
  const [reference, setReference] = useState(journal?.reference ?? '');
  const [source, setSource] = useState<'MANUAL' | 'OPENING'>(
    journal?.source === 'OPENING' ? 'OPENING' : 'MANUAL',
  );
  const [lines, setLines] = useState<LineDraft[]>(
    journal
      ? journal.lines.map((line) => ({
          key: nextKey++,
          accountId: line.accountId,
          branchId: line.branchId ?? '',
          description: line.description,
          debit: filsOrZero(line.debit) > 0n ? line.debit : '',
          credit: filsOrZero(line.credit) > 0n ? line.credit : '',
        }))
      : [emptyLine(), emptyLine()],
  );

  const postable = (accounts.data ?? [])
    .filter((account) => account.isPostable && account.isActive)
    .sort((a, b) => a.code.localeCompare(b.code));
  const debit = lines.reduce((sum, line) => sum + filsOrZero(line.debit), 0n);
  const credit = lines.reduce((sum, line) => sum + filsOrZero(line.credit), 0n);
  const difference = debit - credit;

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['journals', companyId] });
    await queryClient.invalidateQueries({ queryKey: ['journal', companyId] });
  };

  const body = () => ({
    date,
    description,
    reference,
    source,
    lines: lines
      .filter((line) => line.accountId || filsOrZero(line.debit) || filsOrZero(line.credit))
      .map((line) => ({
        accountId: line.accountId,
        branchId: line.branchId || null,
        description: line.description,
        debit: line.debit.trim() || '0',
        credit: line.credit.trim() || '0',
      })),
  });

  const save = () =>
    journal
      ? request<Journal>(`/companies/${companyId}/journals/${journal.id}`, {
          method: 'PUT',
          body: body(),
        })
      : request<Journal>(`/companies/${companyId}/journals`, { method: 'POST', body: body() });

  const saveDraft = useMutation({
    mutationFn: save,
    onSuccess: async (saved) => {
      await invalidate();
      void navigate(`/c/${companyId}/journals/${saved.id}`, { replace: true });
    },
  });
  const post = useMutation({
    mutationFn: async () => {
      const saved = await save();
      return request<Journal>(`/companies/${companyId}/journals/${saved.id}/post`, {
        method: 'POST',
      });
    },
    onSuccess: async (posted) => {
      await invalidate();
      void navigate(`/c/${companyId}/journals/${posted.id}`, { replace: true });
    },
    onError: invalidate,
  });
  const remove = useMutation({
    mutationFn: () =>
      request<void>(`/companies/${companyId}/journals/${journal?.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await invalidate();
      void navigate(`/c/${companyId}/journals`, { replace: true });
    },
  });

  const update = (key: number, change: Partial<LineDraft>) =>
    setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)));
  const busy = saveDraft.isPending || post.isPending || remove.isPending;

  if (accounts.isPending || branches.isPending) return <Loading />;

  return (
    <>
      <PageHeader title={journal ? t('journals.edit') : t('journals.new')}>
        <Link to={`/c/${companyId}/journals`} className={secondaryButtonClass}>
          {t('common.cancel')}
        </Link>
      </PageHeader>
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t('common.date')}>
            <input
              type="date"
              required
              className={inputClass}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <Field label={t('common.description')} className="sm:col-span-2">
            <input
              required
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label={t('common.reference')}>
            <input
              dir="auto"
              className={inputClass}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
          <Field label={t('journals.source')}>
            <select
              className={inputClass}
              value={source}
              onChange={(e) => setSource(e.target.value as 'MANUAL' | 'OPENING')}
            >
              <option value="MANUAL">{t('journalSource.MANUAL')}</option>
              <option value="OPENING">{t('journalSource.OPENING')}</option>
            </select>
          </Field>
        </div>
      </Card>
      <Card className="mb-4 overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>{t('journals.account')}</th>
              <th className={thClass}>{t('common.branch')}</th>
              <th className={thClass}>{t('common.description')}</th>
              <th className={`${thClass} w-36 text-end`}>{t('common.debit')}</th>
              <th className={`${thClass} w-36 text-end`}>{t('common.credit')}</th>
              <th className={thClass} />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.key}>
                <td className={tdClass}>
                  <select
                    aria-label={`${t('journals.account')} ${index + 1}`}
                    className={cellInput}
                    value={line.accountId}
                    onChange={(e) => update(line.key, { accountId: e.target.value })}
                  >
                    <option value="">{t('journals.chooseAccount')}</option>
                    {postable.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} · {name(account.name)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={tdClass}>
                  <select
                    aria-label={`${t('common.branch')} ${index + 1}`}
                    className={cellInput}
                    value={line.branchId}
                    onChange={(e) => update(line.key, { branchId: e.target.value })}
                  >
                    <option value="">{t('journals.noBranch')}</option>
                    {branches.data?.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {name(branch.name)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={tdClass}>
                  <input
                    aria-label={`${t('common.description')} ${index + 1}`}
                    className={cellInput}
                    value={line.description}
                    onChange={(e) => update(line.key, { description: e.target.value })}
                  />
                </td>
                <td className={tdClass}>
                  <input
                    aria-label={`${t('common.debit')} ${index + 1}`}
                    dir="ltr"
                    inputMode="decimal"
                    className={`${cellInput} text-end tabular-nums`}
                    value={line.debit}
                    onChange={(e) => update(line.key, { debit: e.target.value, credit: '' })}
                  />
                </td>
                <td className={tdClass}>
                  <input
                    aria-label={`${t('common.credit')} ${index + 1}`}
                    dir="ltr"
                    inputMode="decimal"
                    className={`${cellInput} text-end tabular-nums`}
                    value={line.credit}
                    onChange={(e) => update(line.key, { credit: e.target.value, debit: '' })}
                  />
                </td>
                <td className={tdClass}>
                  <button
                    type="button"
                    className="text-sm text-slate-500 hover:text-red-700 disabled:opacity-40"
                    disabled={lines.length <= 2}
                    onClick={() => setLines(lines.filter((other) => other.key !== line.key))}
                  >
                    {t('journals.removeLine')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className={tdClass} colSpan={3}>
                <button
                  type="button"
                  className={secondaryButtonClass}
                  onClick={() => setLines([...lines, emptyLine()])}
                >
                  {t('journals.addLine')}
                </button>
                <span className="ms-4">{t('journals.totals')}</span>
              </td>
              <td className={numClass}>
                <Amount value={fromFils(debit)} />
              </td>
              <td className={numClass}>
                <Amount value={fromFils(credit)} />
              </td>
              <td className={tdClass} />
            </tr>
            <tr>
              <td className={tdClass} colSpan={3}>
                {t('journals.difference')}
              </td>
              <td
                className={`${numClass} ${difference === 0n ? 'text-emerald-700' : 'text-red-700'}`}
                colSpan={2}
              >
                <Amount value={fromFils(difference < 0n ? -difference : difference)} />
              </td>
              <td className={tdClass} />
            </tr>
          </tfoot>
        </table>
      </Card>
      <div className="mb-3">
        <ErrorText error={saveDraft.error ?? post.error ?? remove.error} />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={busy}
          onClick={() => saveDraft.mutate()}
        >
          {t('journals.saveDraft')}
        </button>
        {canPost && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy || difference !== 0n || debit === 0n}
            onClick={() => {
              if (window.confirm(t('journals.confirmPost'))) post.mutate();
            }}
          >
            {t('journals.post')}
          </button>
        )}
        {journal && (
          <button
            type="button"
            className={dangerButtonClass}
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('journals.confirmDelete'))) remove.mutate();
            }}
          >
            {t('journals.deleteDraft')}
          </button>
        )}
      </div>
    </>
  );
}

function PostedJournal({ journal }: { journal: Journal }) {
  const { t } = useTranslation();
  const companyId = useCompanyId();
  const name = useName();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canPost = useCan('journals.post');
  const branches = useBranches(companyId);
  const [reverseDate, setReverseDate] = useState(today());

  const reverse = useMutation({
    mutationFn: () =>
      request<Journal>(`/companies/${companyId}/journals/${journal.id}/reverse`, {
        method: 'POST',
        body: { date: reverseDate },
      }),
    onSuccess: async (reversal) => {
      await queryClient.invalidateQueries({ queryKey: ['journals', companyId] });
      await queryClient.invalidateQueries({ queryKey: ['journal', companyId] });
      void navigate(`/c/${companyId}/journals/${reversal.id}`);
    },
  });

  const branchName = (id: string | null) => {
    const found = branches.data?.find((branch) => branch.id === id);
    return found ? name(found.name) : '';
  };

  return (
    <>
      <PageHeader title={`${t('journals.title')} #${journal.number ?? ''}`}>
        <Link to={`/c/${companyId}/journals`} className={secondaryButtonClass}>
          {t('journals.title')}
        </Link>
      </PageHeader>
      <Card className="mb-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-slate-500">{t('common.date')}</dt>
            <dd dir="ltr" className="text-start">
              {journal.date}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-slate-500">{t('common.description')}</dt>
            <dd>{journal.description}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t('common.reference')}</dt>
            <dd dir="auto">{journal.reference}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t('journals.source')}</dt>
            <dd>{t(`journalSource.${journal.source}`)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t('common.status')}</dt>
            <dd>{t(`journalStatus.${journal.status}`)}</dd>
          </div>
          {journal.reversesId && (
            <div>
              <dt className="text-slate-500">{t('journals.reverses')}</dt>
              <dd>
                <Link className="underline" to={`/c/${companyId}/journals/${journal.reversesId}`}>
                  {t('journals.reverses')}
                </Link>
              </dd>
            </div>
          )}
          {journal.reversedById && (
            <div>
              <dt className="text-slate-500">{t('journals.reversedBy')}</dt>
              <dd>
                <Link className="underline" to={`/c/${companyId}/journals/${journal.reversedById}`}>
                  {t('journals.reversedBy')}
                </Link>
              </dd>
            </div>
          )}
        </dl>
      </Card>
      <Card className="mb-4 overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr>
              <th className={thClass}>{t('journals.account')}</th>
              <th className={thClass}>{t('common.branch')}</th>
              <th className={thClass}>{t('common.description')}</th>
              <th className={`${thClass} text-end`}>{t('common.debit')}</th>
              <th className={`${thClass} text-end`}>{t('common.credit')}</th>
            </tr>
          </thead>
          <tbody>
            {journal.lines.map((line) => (
              <tr key={line.id}>
                <td className={tdClass}>
                  <span dir="ltr" className="tabular-nums">
                    {line.accountCode}
                  </span>{' '}
                  · {name(line.accountName)}
                </td>
                <td className={tdClass}>{branchName(line.branchId)}</td>
                <td className={tdClass}>{line.description}</td>
                <td className={numClass}>
                  <Amount value={line.debit} />
                </td>
                <td className={numClass}>
                  <Amount value={line.credit} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className={tdClass} colSpan={3}>
                {t('journals.totals')}
              </td>
              <td className={numClass}>
                <Amount value={journal.totalDebit} />
              </td>
              <td className={numClass}>
                <Amount value={journal.totalCredit} />
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>
      {canPost && !journal.reversedById && (
        <Card>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              reverse.mutate();
            }}
          >
            <Field label={t('journals.reverseDate')}>
              <input
                type="date"
                required
                className={inputClass}
                value={reverseDate}
                onChange={(e) => setReverseDate(e.target.value)}
              />
            </Field>
            <button type="submit" className={dangerButtonClass} disabled={reverse.isPending}>
              {t('journals.reverse')}
            </button>
          </form>
          <div className="mt-3">
            <ErrorText error={reverse.error} />
          </div>
        </Card>
      )}
    </>
  );
}

export function JournalPage() {
  const companyId = useCompanyId();
  const { journalId } = useParams();
  const journal = useQuery({
    queryKey: ['journal', companyId, journalId],
    queryFn: () => request<Journal>(`/companies/${companyId}/journals/${journalId}`),
    enabled: journalId !== undefined,
  });

  if (journalId && journal.isPending) return <Loading />;
  if (journal.error) return <ErrorText error={journal.error} />;
  if (journal.data?.status === 'POSTED') return <PostedJournal journal={journal.data} />;
  return <JournalEditor key={journal.data?.id ?? 'new'} journal={journal.data} />;
}
