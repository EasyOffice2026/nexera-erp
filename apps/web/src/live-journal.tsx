import {
  AMOUNT_PATTERN,
  fromFils,
  journalInputSchema,
  toFils,
  type Journal,
  type JournalInput,
  type LedgerAccount,
  type Period,
} from '@nexera/shared';
import { useState, type FormEvent } from 'react';
import { errorMessage, formatAmount, formatDay, today } from './live-api';
import { Dialog, Icon } from './ui';

export function JournalStatus({
  status,
  reversed = false,
}: {
  status: 'DRAFT' | 'POSTED';
  reversed?: boolean;
}) {
  const draft = status === 'DRAFT';
  return (
    <span className={`status ${draft ? 'draft' : reversed ? '' : 'posted'}`}>
      <i />
      {draft ? 'Draft' : reversed ? 'Reversed' : 'Posted'}
    </span>
  );
}

export const journalLabel = (number: number | null) =>
  number === null ? 'Draft' : `JE-${String(number).padStart(4, '0')}`;

type Line = {
  key: number;
  accountId: string;
  branchId: string | null;
  description: string;
  debit: string;
  credit: string;
};
const blankLine = (key: number): Line => ({
  key,
  accountId: '',
  branchId: null,
  description: '',
  debit: '',
  credit: '',
});

export function JournalEditor({
  journal,
  accounts,
  periods,
  period,
  currency,
  language,
  save,
  close,
}: {
  journal: Journal | null;
  accounts: LedgerAccount[];
  periods: Period[];
  period: Period;
  currency: string;
  language: 'en' | 'ar';
  save: (draft: JournalInput) => Promise<void>;
  close: () => void;
}) {
  const [lines, setLines] = useState<Line[]>(() =>
    journal
      ? journal.lines.map((line) => ({
          ...line,
          key: line.lineNo,
          debit: toFils(line.debit) ? line.debit : '',
          credit: toFils(line.credit) ? line.credit : '',
        }))
      : [blankLine(1), blankLine(2)],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = accounts.filter((account) => account.isActive && account.isPostable);
  const debit = lines.reduce(
    (sum, line) => sum + (AMOUNT_PATTERN.test(line.debit) ? toFils(line.debit) : 0n),
    0n,
  );
  const credit = lines.reduce(
    (sum, line) => sum + (AMOUNT_PATTERN.test(line.credit) ? toFils(line.credit) : 0n),
    0n,
  );
  const date = today();
  const initial = date >= period.startDate && date <= period.endDate ? date : period.startDate;

  function change(key: number, update: Partial<Line>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...update } : line)),
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    const data = new FormData(event.currentTarget);
    const input = journalInputSchema.safeParse({
      date: data.get('date'),
      description: data.get('description'),
      reference: data.get('reference'),
      source: journal?.source ?? 'MANUAL',
      lines: lines.map(({ accountId, branchId, description, debit, credit }) => ({
        accountId,
        branchId,
        description,
        debit: debit || '0',
        credit: credit || '0',
      })),
    });
    if (!input.success) {
      const issue = input.error.issues[0];
      const index = issue?.path[1];
      setError(
        typeof index === 'number'
          ? `Line ${index + 1} needs a posting account and one positive debit or credit with up to three decimal places.`
          : (issue?.message ?? 'Check the journal fields.'),
      );
      return;
    }
    if (debit === 0n || debit !== credit) {
      setError('Total debits and credits must match.');
      return;
    }
    setBusy(true);
    try {
      await save(input.data);
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={journal ? 'Edit journal draft' : 'New journal draft'}
      close={() => {
        if (!busy) close();
      }}
      wide
    >
      <p className="dialog-intro">
        Use a posting account and enter a debit or a credit for each line.
      </p>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="field-grid">
          <label>
            Journal date
            <input name="date" type="date" required defaultValue={journal?.date ?? initial} />
          </label>
          <label>
            Reference
            <input name="reference" maxLength={100} defaultValue={journal?.reference} />
          </label>
        </div>
        <label>
          Description
          <input name="description" required maxLength={500} defaultValue={journal?.description} />
        </label>
        <fieldset className="journal-lines">
          <legend>Journal lines · {currency}</legend>
          {lines.map((line, i) => (
            <div className="journal-line" key={line.key}>
              <label>
                Account {i + 1}
                <select
                  required
                  value={line.accountId}
                  onChange={(event) => change(line.key, { accountId: event.target.value })}
                >
                  <option value="">Choose an account</option>
                  {!active.some((account) => account.id === line.accountId) && line.accountId && (
                    <option value={line.accountId}>Inactive account · choose another</option>
                  )}
                  {active.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} · {account.name[language]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Debit
                <input
                  aria-label={`Debit on line ${i + 1}`}
                  inputMode="decimal"
                  placeholder="0.000"
                  value={line.debit}
                  onChange={(event) => change(line.key, { debit: event.target.value })}
                />
              </label>
              <label>
                Credit
                <input
                  aria-label={`Credit on line ${i + 1}`}
                  inputMode="decimal"
                  placeholder="0.000"
                  value={line.credit}
                  onChange={(event) => change(line.key, { credit: event.target.value })}
                />
              </label>
              <button
                className="icon-button"
                type="button"
                disabled={lines.length <= 2}
                aria-label={`Remove line ${i + 1}`}
                onClick={() =>
                  setLines((current) => current.filter((item) => item.key !== line.key))
                }
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          ))}
          <button
            className="button secondary"
            type="button"
            disabled={lines.length >= 500}
            onClick={() =>
              setLines((current) => [
                ...current,
                blankLine(Math.max(...current.map((line) => line.key)) + 1),
              ])
            }
          >
            <Icon name="plus" size={15} /> Add line
          </button>
        </fieldset>
        <div className="journal-totals">
          <span>
            Debit <strong>{formatAmount(fromFils(debit))}</strong>
          </span>
          <span>
            Credit <strong>{formatAmount(fromFils(credit))}</strong>
          </span>
          {debit > 0n && debit === credit && (
            <span className="status posted">
              <i />
              Balanced
            </span>
          )}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !active.length || !periods.length}>
            {busy ? 'Saving…' : 'Save draft'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function JournalDetail({
  journal,
  currency,
  language,
  canWrite,
  canPost,
  onEdit,
  onAction,
  close,
}: {
  journal: Journal;
  currency: string;
  language: 'en' | 'ar';
  canWrite: boolean;
  canPost: boolean;
  onEdit: () => void;
  close: () => void;
  onAction: (action: 'post' | 'reverse' | 'delete', date?: string) => Promise<void>;
}) {
  const [action, setAction] = useState<'post' | 'reverse' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isDraft = journal.status === 'DRAFT';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || busy) return;
    setBusy(true);
    setError('');
    const date = new FormData(event.currentTarget).get('date');
    try {
      await onAction(action, typeof date === 'string' ? date : undefined);
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={journal.number === null ? 'Journal draft' : journalLabel(journal.number)}
      wide
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="entry-detail">
        <h3>{journal.description}</h3>
        <dl>
          <div>
            <dt>Journal date</dt>
            <dd>{formatDay(journal.date)}</dd>
          </div>
          {journal.reference && (
            <div>
              <dt>Reference</dt>
              <dd>{journal.reference}</dd>
            </div>
          )}
          <div>
            <dt>Status</dt>
            <dd>
              <JournalStatus status={journal.status} reversed={Boolean(journal.reversedById)} />
            </dd>
          </div>
        </dl>
      </div>
      <div className="table-scroll detail-table">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th className="numeric">Debit ({currency})</th>
              <th className="numeric">Credit ({currency})</th>
            </tr>
          </thead>
          <tbody>
            {journal.lines.map((line) => (
              <tr key={line.id}>
                <td>
                  <strong>
                    {line.accountCode} · {line.accountName[language]}
                  </strong>
                  {line.description && <small>{line.description}</small>}
                </td>
                <td className="numeric amount">{formatAmount(line.debit)}</td>
                <td className="numeric amount">{formatAmount(line.credit)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>Total</th>
              <td className="numeric amount">{formatAmount(journal.totalDebit)}</td>
              <td className="numeric amount">{formatAmount(journal.totalCredit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {action ? (
        <form
          className="action-form"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <p>
            {action === 'post'
              ? 'Post this journal to the ledger?'
              : action === 'delete'
                ? 'Permanently delete this draft?'
                : 'A reversal posts the opposite debits and credits in an open period.'}
          </p>
          {action === 'reverse' && (
            <label>
              Reversal date
              <input
                name="date"
                type="date"
                required
                min={journal.date}
                defaultValue={today() >= journal.date ? today() : journal.date}
              />
            </label>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setAction(null);
                setError('');
              }}
            >
              Cancel
            </button>
            <button
              className={`button ${action === 'delete' ? 'danger' : 'primary'}`}
              disabled={busy}
            >
              {busy
                ? 'Working…'
                : action === 'post'
                  ? 'Post journal'
                  : action === 'delete'
                    ? 'Delete draft'
                    : 'Post reversal'}
            </button>
          </div>
        </form>
      ) : (
        <div className="dialog-actions action-form">
          {isDraft && canWrite && (
            <>
              <button className="button secondary" onClick={onEdit}>
                Edit draft
              </button>
              <button className="button secondary" onClick={() => setAction('delete')}>
                Delete
              </button>
            </>
          )}
          {isDraft && canPost && (
            <button className="button primary" onClick={() => setAction('post')}>
              Post journal
            </button>
          )}
          {!isDraft && canPost && !journal.reversedById && (
            <button className="button secondary" onClick={() => setAction('reverse')}>
              Reverse journal
            </button>
          )}
        </div>
      )}
    </Dialog>
  );
}
