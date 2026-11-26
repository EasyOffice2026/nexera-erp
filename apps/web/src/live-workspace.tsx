import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fromFils,
  loginRequestSchema,
  toFils,
  type Journal,
  type JournalInput,
  type JournalSummary,
  type LedgerCompany,
  type LedgerSetup,
  type Page,
  type Session,
  type TrialBalance,
} from '@nexera/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { downloadCsv } from './csv';
import {
  api,
  ApiError,
  errorMessage,
  formatAmount,
  formatDay,
  formatMonth,
  refreshSession,
  today,
} from './live-api';
import { JournalDetail, JournalEditor, JournalStatus, journalLabel } from './live-journal';
import { Dialog, Icon, Mark } from './ui';

type Request = <T>(path: string, options?: { method: string; body?: unknown }) => Promise<T>;
const tabs = [
  ['Overview', 'grid'],
  ['Journal entries', 'book'],
  ['Chart of accounts', 'layers'],
  ['Trial balance', 'chart'],
  ['Fiscal periods', 'calendar'],
] as const;
type Tab = (typeof tabs)[number][0];
const sources = {
  MANUAL: 'Manual entry',
  OPENING: 'Opening balance',
  REVERSAL: 'Reversal',
  INTEGRATION: 'Integration',
};

function QueryState({ error, retry }: { error?: Error | null; retry?: () => void }) {
  return (
    <div className="panel query-state" role={error ? 'alert' : 'status'}>
      <p>{error ? errorMessage(error) : 'Loading workspace…'}</p>
      {error && retry && (
        <button className="button secondary" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

function SignIn({
  restoring,
  initialError,
  onSignIn,
}: {
  restoring: boolean;
  initialError: string;
  onSignIn: (session: Session) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || restoring) return;
    const form = new FormData(event.currentTarget);
    const parsed = loginRequestSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success) {
      setError('Check the tenant, email address, and password.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      onSignIn(await api<Session>('/auth/login', { method: 'POST', body: parsed.data }));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="signin-layout">
      <section className="signin-brand">
        <div className="brand">
          <Mark />
          <span>
            Nexera<strong>ERP</strong>
          </span>
        </div>
        <h1>Accounting workspace</h1>
        <p>Manage journals and reconcile balances across your companies.</p>
        <a className="button secondary" href="#demo">
          Explore the demo <Icon name="right" size={16} />
        </a>
      </section>
      <section className="signin-card">
        <h2>Sign in</h2>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <label>
            Tenant
            <input required name="tenant" autoComplete="organization" maxLength={60} />
          </label>
          <label>
            Email
            <input required name="email" type="email" autoComplete="username" maxLength={200} />
          </label>
          <label>
            Password
            <input
              required
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={200}
            />
          </label>
          {(error || initialError) && (
            <p className="form-error" role="alert">
              {error || initialError}
            </p>
          )}
          <button className="button primary" disabled={busy || restoring}>
            {restoring ? 'Checking session…' : busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

export function LiveWorkspace() {
  const [session, setSession] = useState<Session | null>(null);
  const latest = useRef<Session | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const updateSession = useCallback((next: Session | null) => {
    latest.current = next;
    setSession(next);
  }, []);
  useEffect(() => {
    let mounted = true;
    void refreshSession()
      .then((restored) => {
        if (mounted) updateSession(restored);
      })
      .catch((error: unknown) => {
        if (mounted && !(error instanceof ApiError && error.status === 401))
          setSessionError(errorMessage(error));
      })
      .finally(() => {
        if (mounted) setRestoring(false);
      });
    return () => {
      mounted = false;
    };
  }, [updateSession]);

  const request: Request = useCallback(
    async <T,>(path: string, options?: { method: string; body?: unknown }) => {
      const current = latest.current;
      if (!current) throw new ApiError(401, 'Sign in to continue.');
      try {
        return await api<T>(path, { ...options, token: current.accessToken });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        if (!latest.current) throw error;
        let renewed: Session;
        try {
          renewed = latest.current !== current ? latest.current : await refreshSession();
        } catch (refreshError) {
          if (refreshError instanceof ApiError && refreshError.status === 401) {
            client.clear();
            updateSession(null);
            setSessionError('Your session expired. Sign in again.');
          }
          throw refreshError;
        }
        if (latest.current?.user.id !== renewed.user.id) throw error;
        updateSession(renewed);
        return api<T>(path, { ...options, token: renewed.accessToken });
      }
    },
    [client, updateSession],
  );

  async function signOut() {
    setSigningOut(true);
    setSessionError('');
    try {
      await api('/auth/logout', { method: 'POST' });
      client.clear();
      updateSession(null);
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setSigningOut(false);
    }
  }
  if (!session)
    return (
      <SignIn
        restoring={restoring}
        initialError={sessionError}
        onSignIn={(next) => {
          client.clear();
          setSessionError('');
          updateSession(next);
        }}
      />
    );
  return (
    <QueryClientProvider client={client}>
      <AccountingShell
        session={session}
        request={request}
        signOut={() => {
          void signOut();
        }}
        signingOut={signingOut}
        signOutError={sessionError}
      />
    </QueryClientProvider>
  );
}

function AccountingShell({
  session,
  request,
  signOut,
  signingOut,
  signOutError,
}: {
  session: Session;
  request: Request;
  signOut: () => void;
  signingOut: boolean;
  signOutError: string;
}) {
  const [companyId, setCompanyId] = useState('');
  const [tab, setTab] = useState<Tab>('Overview');
  const [drawer, setDrawer] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const list = useQuery({
    queryKey: ['companies'],
    queryFn: () => request<LedgerCompany[]>('/companies'),
  });
  const companies = list.data ?? [];
  const company = companies.find((item) => item.id === companyId) ?? companies[0];
  const language = session.user.language;
  const initials = session.user.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  function closeDrawer() {
    setDrawer(false);
    launcher.current?.focus();
  }
  return (
    <div className="app">
      {drawer && <button className="scrim" onClick={closeDrawer} aria-label="Close navigation" />}
      <aside
        id="accounting-navigation"
        className={`sidebar ${drawer ? 'is-open' : ''}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && drawer) closeDrawer();
        }}
      >
        <button
          className="brand brand-button"
          onClick={() => {
            setTab('Overview');
            if (drawer) closeDrawer();
          }}
        >
          <Mark />
          <span>
            Nexera<strong>ERP</strong>
          </span>
        </button>
        <div className="workspace-field">
          <span className="workspace-icon">
            <Icon name="building" size={17} />
          </span>
          <div>
            <label htmlFor="live-company">Company</label>
            <select
              id="live-company"
              value={company?.id ?? ''}
              disabled={!companies.length}
              onChange={(event) => {
                setCompanyId(event.target.value);
                if (drawer) closeDrawer();
              }}
            >
              {!companies.length && <option value="">No company</option>}
              {companies.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name[language]}
                </option>
              ))}
            </select>
          </div>
          <Icon name="chevron" size={15} />
        </div>
        <nav aria-label="Main navigation">
          <p className="nav-label">Accounting</p>
          {tabs.map(([name, icon]) => (
            <button
              className={`nav-item ${name === tab ? 'active' : ''}`}
              key={name}
              aria-current={name === tab ? 'page' : undefined}
              onClick={() => {
                setTab(name);
                if (drawer) closeDrawer();
                window.scrollTo(0, 0);
              }}
            >
              <Icon name={icon} />
              {name}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="avatar">{initials}</div>
          <div>
            <strong>{session.user.fullName}</strong>
            <small>{session.user.tenant.name}</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              ref={launcher}
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-expanded={drawer}
              aria-controls="accounting-navigation"
              onClick={() => setDrawer(true)}
            >
              <Icon name="menu" />
            </button>
            <span>Accounting</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{tab}</strong>
          </div>
          <button className="button secondary" disabled={signingOut} onClick={signOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </header>
        <main>
          {signOutError && (
            <p className="form-error" role="alert">
              {signOutError}
            </p>
          )}
          {list.isPending || list.isError ? (
            <QueryState
              error={list.error}
              retry={() => {
                void list.refetch();
              }}
            />
          ) : company ? (
            <CompanyLedger
              key={company.id}
              company={company}
              session={session}
              tab={tab}
              setTab={setTab}
              request={request}
            />
          ) : (
            <div className="panel query-state">
              <h1>No companies yet</h1>
              <p>Ask your workspace administrator to provision your company.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function CompanyLedger({
  company,
  session,
  tab,
  setTab,
  request,
}: {
  company: LedgerCompany;
  session: Session;
  tab: Tab;
  setTab: (tab: Tab) => void;
  request: Request;
}) {
  const [periodId, setPeriodId] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [pageIndex, setPageIndex] = useState(1);
  const [journalId, setJournalId] = useState('');
  const [editing, setEditing] = useState<Journal | null | undefined>();
  const [notice, setNotice] = useState('');
  const client = useQueryClient();
  const base = `/companies/${company.id}`;
  const setup = useQuery({
    queryKey: [company.id, 'setup'],
    queryFn: () => request<LedgerSetup>(`${base}/setup`),
  });
  const periods = setup.data?.periods ?? [];
  const accounts = setup.data?.accounts ?? [];
  const todayDate = today();
  const period =
    periods.find((item) => item.id === periodId) ??
    periods.find((item) => item.startDate <= todayDate && item.endDate >= todayDate) ??
    periods[0];
  const isList = tab === 'Journal entries';
  const filters = new URLSearchParams({
    ...(period ? { from: period.startDate, to: period.endDate } : {}),
    ...(isList && search.trim() ? { search: search.trim() } : {}),
    ...(isList && status ? { status } : {}),
    page: String(isList ? pageIndex : 1),
    pageSize: isList ? '25' : '5',
  }).toString();
  const journals = useQuery({
    queryKey: [company.id, 'journals', filters],
    enabled: Boolean(period) && (isList || tab === 'Overview'),
    queryFn: () => request<Page<JournalSummary>>(`${base}/journals?${filters}`),
  });
  const detail = useQuery({
    queryKey: [company.id, 'journal', journalId],
    enabled: Boolean(journalId) && editing === undefined,
    queryFn: () => request<Journal>(`${base}/journals/${journalId}`),
  });
  const balance = useQuery({
    queryKey: [company.id, 'balance', period?.id],
    enabled: Boolean(period) && (tab === 'Overview' || tab === 'Trial balance'),
    queryFn: () => request<TrialBalance>(`${base}/periods/${period?.id}/trial-balance`),
  });
  const { language, permissions } = session.user;
  const canWrite = permissions.includes('journals.write');
  const canPost = permissions.includes('journals.post');
  const currency = company.currency;
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function refreshLedger() {
    await client.invalidateQueries({ queryKey: [company.id] });
  }

  async function save(input: JournalInput) {
    const saved = await request<Journal>(
      editing ? `${base}/journals/${editing.id}` : `${base}/journals`,
      { method: editing ? 'PUT' : 'POST', body: input },
    );
    const savedPeriod = periods.find(
      (item) => item.startDate <= saved.date && item.endDate >= saved.date,
    );
    if (savedPeriod) setPeriodId(savedPeriod.id);
    setPageIndex(1);
    setSearch('');
    setStatus('');
    setEditing(undefined);
    setJournalId('');
    setTab('Journal entries');
    setNotice('Journal draft saved');
    await refreshLedger();
  }

  async function act(action: 'post' | 'reverse' | 'delete', date?: string) {
    const path = `${base}/journals/${journalId}`;
    if (action === 'delete') {
      await request(path, { method: 'DELETE' });
      setPageIndex(1);
    } else {
      const journal = await request<Journal>(`${path}/${action}`, {
        method: 'POST',
        ...(date ? { body: { date } } : {}),
      });
      if (action === 'reverse') {
        const reversalPeriod = periods.find(
          (item) => item.startDate <= journal.date && item.endDate >= journal.date,
        );
        if (reversalPeriod) setPeriodId(reversalPeriod.id);
        setPageIndex(1);
        setSearch('');
        setStatus('');
      }
    }
    setJournalId('');
    setNotice(
      action === 'post'
        ? 'Journal posted'
        : action === 'reverse'
          ? 'Reversal posted'
          : 'Draft deleted',
    );
    await refreshLedger();
  }

  if (!setup.data)
    return (
      <QueryState
        error={setup.error}
        retry={() => {
          void setup.refetch();
        }}
      />
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{tab === 'Overview' ? 'Financial overview' : tab}</h1>
          <p>
            {company.name[language]}
            {period ? ` · ${formatMonth(period.startDate)}` : ''}
          </p>
        </div>
        <div className="page-actions">
          {period && (
            <label className="period-field">
              <Icon name="calendar" size={17} />
              <select
                aria-label="Reporting period"
                value={period.id}
                onChange={(event) => {
                  setPeriodId(event.target.value);
                  setPageIndex(1);
                }}
              >
                {periods.map((item) => (
                  <option key={item.id} value={item.id}>
                    {formatMonth(item.startDate)}
                  </option>
                ))}
              </select>
              <Icon name="chevron" size={15} />
            </label>
          )}
          {period && canWrite && (
            <button
              className="button primary"
              disabled={!accounts.some((account) => account.isPostable && account.isActive)}
              onClick={() => setEditing(null)}
            >
              <Icon name="plus" size={17} /> New journal
            </button>
          )}
        </div>
      </div>
      {!period && tab !== 'Chart of accounts' && (
        <div className="panel query-state">
          <h2>No fiscal periods</h2>
          <p>Ask your workspace administrator to set up a fiscal year.</p>
        </div>
      )}
      {period &&
        tab === 'Overview' &&
        (balance.data ? (
          <Overview balance={balance.data} currency={currency} />
        ) : (
          <QueryState
            error={balance.error}
            retry={() => {
              void balance.refetch();
            }}
          />
        ))}
      {period && (tab === 'Overview' || isList) && (
        <section className="panel table-panel">
          <div className="panel-heading tools">
            {isList ? (
              <>
                <label className="search-field">
                  <Icon name="search" />
                  <input
                    aria-label="Search journals"
                    placeholder="Search journals"
                    maxLength={100}
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setPageIndex(1);
                    }}
                  />
                </label>
                <div className="table-actions">
                  <select
                    aria-label="Entry status"
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value);
                      setPageIndex(1);
                    }}
                  >
                    <option value="">All statuses</option>
                    <option value="POSTED">Posted</option>
                    <option value="DRAFT">Draft</option>
                  </select>
                  <button
                    className="button secondary"
                    disabled={!journals.data?.items.length}
                    onClick={() => {
                      if (!journals.data) return;
                      downloadCsv(
                        `nexera-journals-${period.startDate}-page-${pageIndex}.csv`,
                        [
                          'Entry',
                          'Description',
                          'Date',
                          'Status',
                          'Reference',
                          `Debit (${currency})`,
                        ],
                        journals.data.items.map((item) => [
                          journalLabel(item.number),
                          item.description,
                          item.date,
                          item.reversedById ? 'Reversed' : item.status,
                          item.reference,
                          item.totalDebit,
                        ]),
                      );
                    }}
                  >
                    <Icon name="download" size={16} /> Export page
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <h2>Recent journals</h2>
                  <p>Latest entries for the selected period</p>
                </div>
                <button className="button secondary" onClick={() => setTab('Journal entries')}>
                  View journals <Icon name="right" size={16} />
                </button>
              </>
            )}
          </div>
          {journals.data ? (
            <>
              <DataTable
                columns={['Entry', 'Description', 'Date', 'Status', `Debit (${currency})`]}
                numericFrom={4}
                empty="No journals match this view."
                journalList
              >
                {journals.data.items.map((journal) => (
                  <tr key={journal.id}>
                    <td>
                      <button
                        className="entry-link"
                        aria-label={`Open ${journalLabel(journal.number)} · ${journal.description}`}
                        onClick={() => setJournalId(journal.id)}
                      >
                        {journalLabel(journal.number)}
                      </button>
                    </td>
                    <td>
                      <strong>{journal.description}</strong>
                      <small>
                        {sources[journal.source]}
                        {journal.reference ? ` · ${journal.reference}` : ''}
                      </small>
                    </td>
                    <td className="nowrap muted">{formatDay(journal.date)}</td>
                    <td>
                      <JournalStatus
                        status={journal.status}
                        reversed={Boolean(journal.reversedById)}
                      />
                    </td>
                    <td className="numeric amount">{formatAmount(journal.totalDebit)}</td>
                  </tr>
                ))}
              </DataTable>
              {isList && journals.data.total > journals.data.pageSize && (
                <div className="pagination">
                  <span>
                    {(journals.data.page - 1) * journals.data.pageSize + 1}–
                    {Math.min(journals.data.page * journals.data.pageSize, journals.data.total)} of{' '}
                    {journals.data.total}
                  </span>
                  <button
                    className="button secondary"
                    disabled={pageIndex === 1}
                    onClick={() => setPageIndex(pageIndex - 1)}
                  >
                    Previous
                  </button>
                  <button
                    className="button secondary"
                    disabled={pageIndex * journals.data.pageSize >= journals.data.total}
                    onClick={() => setPageIndex(pageIndex + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          ) : (
            <QueryState
              error={journals.error}
              retry={() => {
                void journals.refetch();
              }}
            />
          )}
        </section>
      )}
      {tab === 'Chart of accounts' && (
        <section className="panel table-panel">
          <DataTable
            columns={['Code', 'Account', 'Type', 'Status']}
            empty="No accounts have been provisioned."
          >
            {accounts.map((account) => (
              <tr key={account.id}>
                <td className="code">{account.code}</td>
                <td>
                  <strong>{account.name[language]}</strong>
                </td>
                <td className="account-type">{account.type.toLowerCase()}</td>
                <td>
                  <span
                    className={`status ${account.isActive && account.isPostable ? 'open' : ''}`}
                  >
                    <i />
                    {!account.isActive ? 'Inactive' : account.isPostable ? 'Posting' : 'Header'}
                  </span>
                </td>
              </tr>
            ))}
          </DataTable>
        </section>
      )}
      {period &&
        tab === 'Trial balance' &&
        (balance.data ? (
          <BalanceTable balance={balance.data} language={language} currency={currency} />
        ) : (
          <QueryState
            error={balance.error}
            retry={() => {
              void balance.refetch();
            }}
          />
        ))}
      {period && tab === 'Fiscal periods' && (
        <section className="panel table-panel">
          <DataTable
            columns={['Period', 'Start date', 'End date', 'Status']}
            empty="No fiscal periods."
          >
            {periods.map((item) => (
              <tr key={item.id}>
                <td>
                  <button
                    className="entry-link"
                    onClick={() => {
                      setPeriodId(item.id);
                      setTab('Overview');
                      setPageIndex(1);
                    }}
                  >
                    {formatMonth(item.startDate)}
                  </button>
                </td>
                <td>{formatDay(item.startDate)}</td>
                <td>{formatDay(item.endDate)}</td>
                <td>
                  <span className={`status ${item.status === 'OPEN' ? 'open' : 'closed'}`}>
                    <i />
                    {item.status === 'OPEN' ? 'Open' : 'Closed'}
                  </span>
                </td>
              </tr>
            ))}
          </DataTable>
        </section>
      )}
      {journalId &&
        editing === undefined &&
        (detail.data ? (
          <JournalDetail
            key={journalId}
            journal={detail.data}
            currency={currency}
            language={language}
            canWrite={canWrite}
            canPost={canPost}
            onEdit={() => setEditing(detail.data)}
            onAction={act}
            close={() => setJournalId('')}
          />
        ) : (
          <Dialog title="Journal details" close={() => setJournalId('')}>
            <QueryState
              error={detail.error}
              retry={() => {
                void detail.refetch();
              }}
            />
          </Dialog>
        ))}
      {period && editing !== undefined && (
        <JournalEditor
          journal={editing}
          accounts={accounts}
          periods={periods}
          period={period}
          currency={currency}
          language={language}
          save={save}
          close={() => setEditing(undefined)}
        />
      )}
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" />
          {notice}
        </div>
      )}
    </>
  );
}

function DataTable({
  columns,
  children,
  empty,
  numericFrom = Infinity,
  footer,
  journalList = false,
}: {
  columns: string[];
  children: ReactNode[];
  empty: string;
  numericFrom?: number;
  footer?: ReactNode;
  journalList?: boolean;
}) {
  if (!children.length && !footer) return <p className="empty">{empty}</p>;
  return (
    <div
      className={`table-scroll${journalList ? ' journal-table' : ''}`}
      tabIndex={0}
      role="region"
      aria-label={columns.join(', ')}
    >
      <table role={journalList ? 'table' : undefined}>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th scope="col" key={column} className={index >= numericFrom ? 'numeric' : undefined}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children.length ? (
            children
          ) : (
            <tr>
              <td colSpan={columns.length} className="empty">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}

function Overview({ balance, currency }: { balance: TrialBalance; currency: string }) {
  const change = (type: 'REVENUE' | 'EXPENSE') =>
    balance.rows
      .filter((row) => row.type === type)
      .reduce((sum, row) => sum + toFils(row.periodDebit) - toFils(row.periodCredit), 0n);
  const revenue = -change('REVENUE');
  const expenses = change('EXPENSE');
  const cash = balance.rows
    .filter((row) => row.subtype === 'cash' || row.subtype === 'bank')
    .reduce((sum, row) => sum + toFils(row.closingDebit) - toFils(row.closingCredit), 0n);
  const metrics = [
    ['Revenue', revenue, 'trend', 'violet'],
    ['Expenses', expenses, 'expense', 'amber'],
    ['Net income', revenue - expenses, 'coins', 'green'],
    ['Closing cash balance', cash, 'wallet', 'blue'],
  ] as const;
  return (
    <div className="kpi-grid">
      {metrics.map(([label, amount, icon, tone]) => (
        <section className="panel kpi" key={label}>
          <div className="kpi-top">
            <span className={`metric-icon ${tone}`}>
              <Icon name={icon} />
            </span>
          </div>
          <h2>{label}</h2>
          <div className="metric-value">
            {formatAmount(fromFils(amount))} <span>{currency}</span>
          </div>
        </section>
      ))}
    </div>
  );
}

function BalanceTable({
  balance,
  currency,
  language,
}: {
  balance: TrialBalance;
  currency: string;
  language: 'en' | 'ar';
}) {
  const keys = [
    'openingDebit',
    'openingCredit',
    'periodDebit',
    'periodCredit',
    'closingDebit',
    'closingCredit',
  ] as const;
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>Balance by account</h2>
          <p>Posted entries · {currency}</p>
        </div>
        {balance.totals.closingDebit === balance.totals.closingCredit ? (
          <span className="status posted">
            <i />
            Balanced
          </span>
        ) : (
          <span className="status draft">
            <i />
            Out of balance
          </span>
        )}
      </div>
      <DataTable
        columns={[
          'Code',
          'Account',
          'Opening debit',
          'Opening credit',
          'Period debit',
          'Period credit',
          'Closing debit',
          'Closing credit',
        ]}
        numericFrom={2}
        empty="No accounts to reconcile."
        footer={
          <tr>
            <th colSpan={2}>Total</th>
            {keys.map((key) => (
              <td className="numeric amount" key={key}>
                {formatAmount(balance.totals[key])}
              </td>
            ))}
          </tr>
        }
      >
        {balance.rows.map((row) => (
          <tr key={row.accountId}>
            <td className="code">{row.code}</td>
            <td>
              <strong>{row.name[language]}</strong>
            </td>
            {keys.map((key) => (
              <td className="numeric amount" key={key}>
                {row[key] === '0.000' ? '—' : formatAmount(row[key])}
              </td>
            ))}
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
