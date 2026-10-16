import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { buttonClass, ErrorText, Field, inputClass } from '../../components/ui';
import { LanguageSwitcher } from '../../i18n/LanguageSwitcher';
import { useAuth } from './auth-context';

export function LoginPage() {
  const { t } = useTranslation();
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [tenant, setTenant] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/';
  if (status === 'authenticated') return <Navigate to={from} replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ tenant, email, password });
      void navigate(from, { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-slate-500">{t('app.name')}</p>
            <h1 className="text-xl font-semibold text-slate-900">{t('auth.signInTitle')}</h1>
          </div>
          <LanguageSwitcher />
        </div>
        <form onSubmit={(event) => void onSubmit(event)} className="space-y-4">
          <Field label={t('auth.tenant')}>
            <input
              required
              autoComplete="organization"
              dir="ltr"
              value={tenant}
              onChange={(event) => setTenant(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label={t('auth.email')}>
            <input
              type="email"
              required
              autoComplete="username"
              dir="ltr"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label={t('auth.password')}>
            <input
              type="password"
              required
              autoComplete="current-password"
              dir="ltr"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
            />
          </Field>
          <ErrorText error={error} />
          <button type="submit" disabled={submitting} className={`${buttonClass} w-full`}>
            {submitting ? t('auth.submitting') : t('auth.submit')}
          </button>
        </form>
      </div>
    </main>
  );
}
