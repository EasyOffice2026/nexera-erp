import {
  amountSchema,
  fromFils,
  isoDateSchema,
  journalLineSchema,
  toFils,
  type JournalInput,
  type LedgerAccount,
} from '@nexera/shared';
import { lazy, StrictMode, Suspense, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { downloadCsv } from './csv';
import { formatAmount } from './live-api';
import { JournalEditor } from './live-journal';
import { Dialog, Icon, Mark, type IconName } from './ui';
import './styles.css';

const LiveWorkspace = lazy(() =>
  import('./live-workspace').then((module) => ({ default: module.LiveWorkspace })),
);

const companies = ['Mudawwarah', 'Khubuz Maraei'] as const;
const periods = ['November 2026', 'October 2026', 'September 2026'] as const;
const sections = [
  { name: 'Overview', icon: 'grid' },
  { name: 'Journal entries', icon: 'book' },
  { name: 'Chart of accounts', icon: 'layers' },
  { name: 'Trial balance', icon: 'chart' },
  { name: 'Fiscal periods', icon: 'calendar' },
] as const;
type Company = (typeof companies)[number];
type Period = (typeof periods)[number];
type Section = (typeof sections)[number]['name'];
const savedEntry = z.object({
  id: z.string().regex(/^JE-\d{1,10}$/),
  date: isoDateSchema,
  description: z.string(),
  source: z.string(),
  status: z.enum(['Posted', 'Draft']),
  amount: z.union([
    amountSchema,
    z
      .number()
      .nonnegative()
      .max(999_999_999.999)
      .transform((amount) => amount.toFixed(3)),
  ]),
  company: z.enum(companies),
  lines: z.array(journalLineSchema).optional(),
});
type Entry = z.output<typeof savedEntry>;

const descriptions = [
  ['Daily sales settlement', 'POS integration', 'Posted', 3248.75],
  ['Supplier payment · Fresh Market', 'Manual entry', 'Posted', 1275],
  ['November rent accrual', 'Manual entry', 'Draft', 2200],
  ['KNET payout reconciliation', 'Bank settlement', 'Posted', 4890.125],
  ['Kitchen inventory adjustment', 'Manual entry', 'Posted', 486.35],
] as const;
const initialEntries: Entry[] = companies.flatMap((company, ci) =>
  periods.flatMap((_, pi) =>
    descriptions.map(([description, source, status, amount], i) => ({
      id: `JE-${1048 - i - pi * 15 - ci * 100}`,
      date: `2026-${11 - pi}-${26 - i}`,
      description,
      source,
      status,
      amount: (amount * (1 - pi * 0.12 - ci * 0.25)).toFixed(3),
      company,
    })),
  ),
);

const accounts = [
  ['1000', 'Cash and cash equivalents', 'Asset', 62840.75, 0],
  ['1100', 'Trade receivables', 'Asset', 18450.25, 0],
  ['1200', 'Inventory', 'Asset', 14270, 0],
  ['2000', 'Trade payables', 'Liability', 0, 16352.3],
  ['3000', 'Retained earnings', 'Equity', 0, 62468.025],
  ['4000', 'Restaurant sales', 'Revenue', 0, 84250],
  ['5000', 'Operating expenses', 'Expense', 67509.325, 0],
] as const;

const demoPeriods = periods.map((name, index) => ({
  id: name,
  number: 11 - index,
  startDate: `2026-${11 - index}-01`,
  endDate: `2026-${11 - index}-${index === 1 ? 31 : 30}`,
  status: index === 0 ? ('OPEN' as const) : ('CLOSED' as const),
}));
const demoAccounts = (
  [
    ['1000', 'Cash and cash equivalents', 'ASSET', 'cash'],
    ['1100', 'Trade receivables', 'ASSET', 'receivable'],
    ['1200', 'Inventory', 'ASSET', 'inventory'],
    ['2000', 'Trade payables', 'LIABILITY', 'payable'],
    ['3000', 'Retained earnings', 'EQUITY', 'retained_earnings'],
    ['4000', 'Restaurant sales', 'REVENUE', 'sales'],
    ['5000', 'Operating expenses', 'EXPENSE', 'operating_expense'],
  ] as const
).map(([code, label, type, subtype]) => ({
  id: `00000000-0000-4000-8000-${code.padStart(12, '0')}`,
  code,
  name: { en: label, ar: label },
  type,
  subtype,
  isActive: true,
  isPostable: true,
})) satisfies LedgerAccount[];

const money = new Intl.NumberFormat('en-KW', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});
const formatDate = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const dateText = (date: string) => formatDate.format(new Date(date));
const scaled = (value: number, factor: number) => Math.round(value * factor * 1000) / 1000;
const storageKey = 'nexera-demo-journals-v1';

function readEntries(): Entry[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return initialEntries;
    const parsed = z.array(z.unknown()).parse(JSON.parse(raw));
    const entries = new Map(initialEntries.map((entry) => [entry.id, entry]));
    for (const item of parsed) {
      const result = savedEntry.safeParse(item);
      if (result.success) entries.set(result.data.id, result.data);
    }
    return [...entries.values()];
  } catch {
    return initialEntries;
  }
}

function CashFlow({ factor, period }: { factor: number; period: Period }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const month = 10 - periods.indexOf(period);
  const samples = [
    [34, 23],
    [48, 31],
    [43, 28],
    [64, 42],
    [57, 38],
    [79, 52],
  ] as const;
  const months = samples.map(([inflow, outflow], i) => ({
    label: new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, month - 5 + i, 1)),
    ),
    inflow,
    outflow,
  }));
  const highlighted = active === null ? undefined : months[active];
  const describe = ({ label, inflow, outflow }: (typeof months)[number]) =>
    `${label} · In ${money.format(scaled(inflow * 1000, factor))} · Out ${money.format(scaled(outflow * 1000, factor))}`;
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const draw = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      node.width = width * ratio;
      node.height = height * ratio;
      const ctx = node.getContext('2d');
      if (!ctx) return;
      ctx.scale(ratio, ratio);
      const left = 40;
      const right = width - 12;
      const top = 12;
      const bottom = height - 25;
      ctx.font = '11px Inter, Segoe UI, sans-serif';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) {
        const y = bottom - ((bottom - top) * i) / 4;
        ctx.strokeStyle = '#eceef4';
        ctx.setLineDash(i ? [4, 4] : []);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.fillStyle = '#737a90';
        ctx.textAlign = 'left';
        ctx.fillText(i ? `${i * 25}k` : '0', 2, y);
      }
      ctx.setLineDash([]);
      const step = (right - left) / 6;
      const bar = Math.min(22, step * 0.26);
      months.forEach(({ label, inflow, outflow }, i) => {
        const x = left + (i + 0.5) * step;
        if (active === i) {
          ctx.fillStyle = '#f4f2ff';
          ctx.fillRect(x - step / 2 + 2, top, step - 4, bottom - top);
        }
        [
          { amount: inflow, start: x - bar - 2, color: '#674ee8' },
          { amount: outflow, start: x + 2, color: '#dcd5ff' },
        ].forEach(({ amount, start, color }) => {
          const barHeight = ((amount * factor) / 100) * (bottom - top);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect(start, bottom - barHeight, bar, barHeight, [4, 4, 0, 0]);
          ctx.fill();
        });
        ctx.textAlign = 'center';
        ctx.fillStyle = '#737a90';
        ctx.fillText(label, x, height - 8);
      });
    };
    const observer = new ResizeObserver(draw);
    observer.observe(node);
    draw();
    return () => observer.disconnect();
  });
  return (
    <section className="panel chart-panel">
      <div className="panel-heading">
        <div>
          <h2>Cash flow</h2>
          <p>Monthly cash movement · KWD</p>
        </div>
      </div>
      <div className="chart-wrap">
        {highlighted && (
          <div className="chart-tooltip" aria-hidden="true">
            {describe(highlighted)}
          </div>
        )}
        <canvas
          ref={canvas}
          aria-label={`Monthly cash flow in Kuwaiti dinars. ${months.map(describe).join('. ')}`}
          role="img"
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left - 40;
            setActive(
              x < 0 || x >= rect.width - 52 ? null : Math.floor(x / ((rect.width - 52) / 6)),
            );
          }}
          onPointerLeave={() => setActive(null)}
        />
      </div>
      <div className="legend">
        <span>
          <i /> Cash in
        </span>
        <span>
          <i /> Cash out
        </span>
      </div>
    </section>
  );
}

function Status({ value }: { value: Entry['status'] | 'Open' | 'Closed' }) {
  return (
    <span className={`status ${value.toLowerCase()}`}>
      <i />
      {value}
    </span>
  );
}

function JournalTable({
  entries,
  onSelect,
}: {
  entries: Entry[];
  onSelect: (entry: Entry) => void;
}) {
  if (!entries.length) return <p className="empty">No journal entries match this view.</p>;
  return (
    <div className="table-scroll journal-table">
      <table role="table">
        <thead>
          <tr>
            <th>Entry</th>
            <th>Description</th>
            <th>Date</th>
            <th>Status</th>
            <th className="numeric">Amount (KWD)</th>
            <th aria-label="Details" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>
                <button className="entry-link" onClick={() => onSelect(entry)}>
                  {entry.id}
                </button>
              </td>
              <td>
                <strong>{entry.description}</strong>
                <small>{entry.source}</small>
              </td>
              <td className="muted nowrap">{dateText(entry.date)}</td>
              <td>
                <Status value={entry.status} />
              </td>
              <td className="numeric amount">{formatAmount(entry.amount)}</td>
              <td>
                <button
                  className="icon-button row-action"
                  onClick={() => onSelect(entry)}
                  aria-label={`View ${entry.id}`}
                >
                  <Icon name="right" size={15} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function App() {
  const [section, setSection] = useState<Section>('Overview');
  const [company, setCompany] = useState<Company>(companies[0]);
  const [period, setPeriod] = useState<Period>(periods[0]);
  const [entries, setEntries] = useState(readEntries);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All statuses');
  const [selected, setSelected] = useState<Entry | null>(null);
  const [creating, setCreating] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const activePeriod = demoPeriods.find((item) => item.id === period) ?? demoPeriods[0]!;
  const datePrefix = activePeriod.startDate.slice(0, 7);
  const factor = (company === companies[0] ? 1 : 0.73) * (1 - periods.indexOf(period) * 0.12);
  const scoped = entries
    .filter((entry) => entry.company === company && entry.date.startsWith(datePrefix))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const filtered = scoped.filter(
    (entry) =>
      (filter === 'All statuses' || filter === entry.status) &&
      `${entry.description} ${entry.id} ${entry.source}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const kpis: { label: string; value: number; icon: IconName; tone: string; change: string }[] = [
    { label: 'Total revenue', value: 84250, icon: 'trend', tone: 'violet', change: '+12.4%' },
    {
      label: 'Operating expenses',
      value: 67509.325,
      icon: 'expense',
      tone: 'amber',
      change: '+4.2%',
    },
    { label: 'Net income', value: 16740.675, icon: 'coins', tone: 'green', change: '+18.6%' },
    { label: 'Cash balance', value: 62840.75, icon: 'wallet', tone: 'blue', change: '+8.1%' },
  ];
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(entries));
    } catch {
      /* The demo remains functional in memory. */
    }
  }, [entries]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function navigate(next: Section) {
    setSection(next);
    setNavOpen(false);
    window.scrollTo(0, 0);
  }

  function createDraft(input: JournalInput) {
    const draftPeriod = demoPeriods.find(
      (item) => input.date >= item.startDate && input.date <= item.endDate,
    );
    if (!draftPeriod)
      return Promise.reject(
        new Error('Choose a date between September and November 2026 in the demo.'),
      );
    const { date, description, lines } = input;
    const amount = fromFils(lines.reduce((total, line) => total + toFils(line.debit), 0n));
    setEntries((current) => {
      const next =
        current.reduce((max, entry) => Math.max(max, Number(entry.id.slice(3))), 1048) + 1;
      return [
        {
          id: `JE-${next}`,
          description,
          amount,
          date,
          source: 'Manual entry',
          status: 'Draft',
          company,
          lines,
        },
        ...current,
      ];
    });
    setPeriod(draftPeriod.id);
    setCreating(false);
    setSearch('');
    setFilter('All statuses');
    navigate('Journal entries');
    setNotice('Journal draft saved');
    return Promise.resolve();
  }

  function exportJournals() {
    downloadCsv(
      `nexera-demo-journals-${datePrefix}.csv`,
      ['Entry', 'Date', 'Description', 'Source', 'Status', 'Amount (KWD)'],
      filtered.map((entry) => [
        entry.id,
        entry.date,
        entry.description,
        entry.source,
        entry.status,
        entry.amount,
      ]),
    );
    setNotice('Journal export downloaded');
  }

  return (
    <div className="app">
      {navOpen && (
        <button className="scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />
      )}
      <aside className={`sidebar ${navOpen ? 'is-open' : ''}`}>
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigate('Overview');
          }}
        >
          <Mark />
          <span>
            Nexera<strong>ERP</strong>
          </span>
        </a>
        <div className="workspace-field">
          <span className="workspace-icon">
            <Icon name="building" size={17} />
          </span>
          <div>
            <label htmlFor="company">Company</label>
            <select
              id="company"
              value={company}
              onChange={(event) => setCompany(event.target.value as Company)}
            >
              {companies.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </div>
          <Icon name="chevron" size={15} />
        </div>
        <nav aria-label="Main navigation">
          {sections.map(({ name, icon }, i) => (
            <div key={name}>
              {i === 0 && <p className="nav-label">Workspace</p>}
              {i === 1 && <p className="nav-label accounting-label">Accounting</p>}
              <button
                className={`nav-item ${section === name ? 'active' : ''}`}
                aria-current={section === name ? 'page' : undefined}
                onClick={() => navigate(name)}
              >
                <Icon name={icon} />
                <span>{name}</span>
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="avatar">NF</div>
          <div>
            <strong>Nexera Finance</strong>
            <small>Demo workspace</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <span>Accounting</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{section}</strong>
          </div>
          <div className="table-actions">
            <span className="demo">
              <i />
              Demo data
            </span>
            <a className="button secondary" href="#live">
              Sign in
            </a>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <h1>{section === 'Overview' ? 'Financial overview' : section}</h1>
              <p>
                {section === 'Overview'
                  ? `Financial performance for ${company}.`
                  : `${company} · ${period}`}
              </p>
            </div>
            <div className="page-actions">
              <label className="period-field">
                <Icon name="calendar" size={17} />
                <select
                  aria-label="Reporting period"
                  value={period}
                  onChange={(event) => setPeriod(event.target.value as Period)}
                >
                  {periods.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                <Icon name="chevron" size={15} />
              </label>
              <button className="button primary" onClick={() => setCreating(true)}>
                <Icon name="plus" size={17} /> New journal
              </button>
            </div>
          </div>
          {section === 'Overview' && (
            <>
              <div className="kpi-grid">
                {kpis.map((kpi) => (
                  <section className="panel kpi" key={kpi.label}>
                    <div className="kpi-top">
                      <span className={`metric-icon ${kpi.tone}`}>
                        <Icon name={kpi.icon} size={18} />
                      </span>
                      <span className={`delta ${kpi.tone === 'amber' ? 'neutral' : ''}`}>
                        {kpi.change}
                      </span>
                    </div>
                    <h2>{kpi.label}</h2>
                    <div className="metric-value">
                      {money.format(scaled(kpi.value, factor))} <span>KWD</span>
                    </div>
                  </section>
                ))}
              </div>
              <div className="analytics">
                <CashFlow key={period} factor={factor} period={period} />
                <section className="panel performance">
                  <div className="panel-heading">
                    <div>
                      <h2>Revenue mix</h2>
                      <p>Sales by channel</p>
                    </div>
                  </div>
                  <div className="mix">
                    <div
                      className="donut"
                      role="img"
                      aria-label="Dine-in 58%, Delivery 27%, Takeaway 15%"
                    >
                      <div>
                        <span>Total revenue</span>
                        <strong>{money.format(scaled(84250, factor))}</strong>
                        <small>KWD</small>
                      </div>
                    </div>
                    <div className="mix-legend">
                      {[
                        ['Dine-in', '58%'],
                        ['Delivery', '27%'],
                        ['Takeaway', '15%'],
                      ].map(([label, share]) => (
                        <div key={label}>
                          <span>
                            <i />
                            {label}
                          </span>
                          <strong>{share}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              </div>
              <section className="panel table-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Recent journal entries</h2>
                    <p>Latest activity for the selected period</p>
                  </div>
                  <button className="button secondary" onClick={() => navigate('Journal entries')}>
                    View journals <Icon name="right" size={16} />
                  </button>
                </div>
                <JournalTable entries={scoped.slice(0, 5)} onSelect={setSelected} />
              </section>
            </>
          )}
          {section === 'Journal entries' && (
            <section className="panel table-panel">
              <div className="panel-heading tools">
                <label className="search-field">
                  <Icon name="search" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search journals"
                    aria-label="Search journals"
                  />
                </label>
                <div className="table-actions">
                  <select
                    aria-label="Entry status"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    {['All statuses', 'Posted', 'Draft'].map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                  <button className="button secondary" onClick={exportJournals}>
                    <Icon name="download" size={16} /> Export CSV
                  </button>
                </div>
              </div>
              <JournalTable entries={filtered} onSelect={setSelected} />
            </section>
          )}
          {(section === 'Chart of accounts' || section === 'Trial balance') && (
            <section className="panel table-panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    {section === 'Trial balance' ? 'Account balances' : 'General ledger accounts'}
                  </h2>
                  <p>
                    {section === 'Trial balance'
                      ? 'Closing balances in KWD'
                      : 'Account codes and classifications'}
                  </p>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Account</th>
                      <th>Type</th>
                      {section === 'Trial balance' && (
                        <>
                          <th className="numeric">Debit</th>
                          <th className="numeric">Credit</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map(([code, name, type, debit, credit]) => (
                      <tr key={code}>
                        <td className="code">{code}</td>
                        <td>
                          <strong>{name}</strong>
                        </td>
                        <td>{type}</td>
                        {section === 'Trial balance' && (
                          <>
                            <td className="numeric amount">
                              {debit ? money.format(scaled(debit, factor)) : '—'}
                            </td>
                            <td className="numeric amount">
                              {credit ? money.format(scaled(credit, factor)) : '—'}
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {section === 'Fiscal periods' && (
            <section className="panel table-panel">
              <div className="panel-heading">
                <div>
                  <h2>Fiscal year 2026</h2>
                  <p>Monthly reporting periods</p>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Start date</th>
                      <th>End date</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((item, i) => (
                      <tr key={item}>
                        <td>
                          <button
                            className="entry-link"
                            onClick={() => {
                              setPeriod(item);
                              navigate('Overview');
                            }}
                          >
                            {item}
                          </button>
                        </td>
                        <td>{dateText(`2026-${11 - i}-01`)}</td>
                        <td>{dateText(`2026-${11 - i}-${i === 1 ? 31 : 30}`)}</td>
                        <td>
                          <Status value={i === 0 ? 'Open' : 'Closed'} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </main>
      </div>
      {creating && (
        <JournalEditor
          journal={null}
          accounts={demoAccounts}
          periods={demoPeriods}
          period={activePeriod}
          currency="KWD"
          language="en"
          save={createDraft}
          close={() => setCreating(false)}
        />
      )}
      {selected && (
        <Dialog
          title={selected.id}
          wide={Boolean(selected.lines?.length)}
          close={() => setSelected(null)}
        >
          <div className="entry-detail">
            <h3>{selected.description}</h3>
            <dl>
              <div>
                <dt>Company</dt>
                <dd>{selected.company}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>{dateText(selected.date)}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{selected.source}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <Status value={selected.status} />
                </dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd className="amount">{formatAmount(selected.amount)} KWD</dd>
              </div>
            </dl>
          </div>
          {selected.lines?.length ? (
            <div className="table-scroll detail-table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col" className="numeric">
                      Debit
                    </th>
                    <th scope="col" className="numeric">
                      Credit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {selected.lines.map((line, index) => (
                    <tr key={index}>
                      <td>
                        {demoAccounts.find((account) => account.id === line.accountId)?.name.en ??
                          'Account unavailable'}
                      </td>
                      <td className="numeric amount">{formatAmount(line.debit)}</td>
                      <td className="numeric amount">{formatAmount(line.credit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Dialog>
      )}
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" />
          {notice}
        </div>
      )}
    </div>
  );
}

function Workspace() {
  const [live, setLive] = useState(window.location.hash === '#live');
  useEffect(() => {
    const selectMode = () => setLive(window.location.hash === '#live');
    window.addEventListener('hashchange', selectMode);
    return () => window.removeEventListener('hashchange', selectMode);
  }, []);
  return live ? (
    <Suspense fallback={<main role="status">Loading workspace…</main>}>
      <LiveWorkspace />
    </Suspense>
  ) : (
    <App />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workspace />
  </StrictMode>,
);
