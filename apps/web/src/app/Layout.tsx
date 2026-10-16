import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { secondaryButtonClass } from '../components/ui';
import { useAuth } from '../features/auth/auth-context';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';
import { useCompanies, useName } from './company';

const sections = ['dashboard', 'journals', 'accounts', 'periods', 'reports'] as const;

function navClass({ isActive }: { isActive: boolean }) {
  return `rounded-md px-3 py-1.5 text-sm ${
    isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-200'
  }`;
}

export function Layout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const { companyId } = useParams();
  const companies = useCompanies();
  const name = useName();
  const navigate = useNavigate();

  // Choosing a company opens its own dashboard.
  function switchCompany(id: string) {
    void navigate(`/c/${id}/dashboard`);
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <span className="font-semibold text-slate-900">{t('app.name')}</span>
          <select
            aria-label={t('nav.company')}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={companyId ?? ''}
            onChange={(event) => switchCompany(event.target.value)}
          >
            {!companyId && <option value="">{t('nav.company')}</option>}
            {companies.data?.map((company) => (
              <option key={company.id} value={company.id}>
                {name(company.name)}
              </option>
            ))}
          </select>
          <nav className="flex flex-wrap gap-1">
            {companyId &&
              sections.map((section) => (
                <NavLink key={section} to={`/c/${companyId}/${section}`} className={navClass}>
                  {t(`nav.${section}`)}
                </NavLink>
              ))}
            <NavLink to="/companies" className={navClass}>
              {t('nav.companies')}
            </NavLink>
          </nav>
          <div className="ms-auto flex items-center gap-2">
            <span className="text-sm text-slate-500">
              {user?.fullName} · {user?.tenant.name}
            </span>
            <LanguageSwitcher />
            <button type="button" className={secondaryButtonClass} onClick={() => void logout()}>
              {t('auth.signOut')}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4">
        <Outlet />
      </main>
    </div>
  );
}
