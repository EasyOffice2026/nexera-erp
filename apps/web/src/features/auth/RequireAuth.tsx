import { Navigate, Outlet, useLocation } from 'react-router';
import { Loading } from '../../components/ui';
import { useAuth } from './auth-context';

// Only lets signed-in people through. Others go to the login page and come back afterwards.
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <Loading />;
  if (status === 'anonymous') {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }
  return <Outlet />;
}
