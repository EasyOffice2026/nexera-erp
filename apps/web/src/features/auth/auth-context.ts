import type { LoginRequest, Permission, SessionUser } from '@nexera/shared';
import { createContext, useContext } from 'react';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  login: (input: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}

export function useCan(permission: Permission): boolean {
  return useAuth().user?.permissions.includes(permission) ?? false;
}
