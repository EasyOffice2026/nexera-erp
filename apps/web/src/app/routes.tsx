import { Navigate, type RouteObject } from 'react-router';
import { ErrorText, Loading } from '../components/ui';
import { AccountsPage } from '../features/accounts/AccountsPage';
import { LoginPage } from '../features/auth/LoginPage';
import { RequireAuth } from '../features/auth/RequireAuth';
import { CompaniesPage } from '../features/companies/CompaniesPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { JournalPage } from '../features/journals/JournalPage';
import { JournalsPage } from '../features/journals/JournalsPage';
import { PeriodsPage } from '../features/periods/PeriodsPage';
import { LedgerPage } from '../features/reports/LedgerPage';
import { ReportsPage } from '../features/reports/ReportsPage';
import { useCompanies } from './company';
import { Layout } from './Layout';

// Opens the dashboard of the first company, or the companies page when there is none yet.
function Home() {
  const companies = useCompanies();
  if (companies.isPending) return <Loading />;
  if (companies.error) return <ErrorText error={companies.error} />;
  const first = companies.data[0];
  return <Navigate to={first ? `/c/${first.id}/dashboard` : '/companies'} replace />;
}

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <Home /> },
          { path: 'companies', element: <CompaniesPage /> },
          {
            path: 'c/:companyId',
            children: [
              { index: true, element: <Navigate to="dashboard" replace /> },
              { path: 'dashboard', element: <DashboardPage /> },
              { path: 'accounts', element: <AccountsPage /> },
              { path: 'journals', element: <JournalsPage /> },
              { path: 'journals/new', element: <JournalPage /> },
              { path: 'journals/:journalId', element: <JournalPage /> },
              { path: 'periods', element: <PeriodsPage /> },
              { path: 'reports', element: <ReportsPage /> },
              { path: 'reports/ledger/:accountId', element: <LedgerPage /> },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];
