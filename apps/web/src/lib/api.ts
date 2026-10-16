import { apiErrorSchema, type Session } from '@nexera/shared';
import { sessionStore } from './session-store';

const BASE_URL = '/api/v1';

// A request that gets no answer for this long fails, so a stalled connection cannot leave the
// app waiting for ever.
const REQUEST_TIMEOUT_MS = 15_000;

// An error answer from the API, with its error code (for example JOURNAL_UNBALANCED).
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function readError(res: Response): Promise<ApiError> {
  try {
    const { error } = apiErrorSchema.parse(await res.json());
    return new ApiError(res.status, error.code, error.message, error.details);
  } catch {
    return new ApiError(res.status, 'UNKNOWN', res.statusText || 'The request failed');
  }
}

function send(path: string, method: string, body: unknown, token: string | null) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function performRefresh(): Promise<Session | null> {
  const before = sessionStore.get();
  try {
    const res = await send('/auth/refresh', 'POST', undefined, null);
    if (res.ok) {
      const session = (await res.json()) as Session;
      sessionStore.set(session);
      return session;
    }
    // The session is really over. Other failures (server down, offline) keep it for a retry.
    if (res.status === 401 && sessionStore.get() === before) sessionStore.set(null);
  } catch {
    // No connection: keep the current session.
  }
  return null;
}

let refreshing: Promise<Session | null> | null = null;

// Gets a new access token from the refresh cookie. Requests that fail at the same moment share
// one refresh, and browser tabs take turns, because every refresh replaces the cookie.
export function refreshSession(): Promise<Session | null> {
  refreshing ??= (
    typeof navigator.locks === 'object'
      ? navigator.locks.request('nexera-auth-refresh', performRefresh)
      : performRefresh()
  ).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  // Sign-in itself has no token to send.
  authenticated?: boolean;
}

// Sends a request and answers its JSON. If the access token has expired, it refreshes the
// session once and tries again.
export async function request<T>(
  path: string,
  { method = 'GET', body, authenticated = true }: RequestOptions = {},
): Promise<T> {
  const call = (token: string | null) => send(path, method, body, token);
  let res = await call(authenticated ? (sessionStore.get()?.accessToken ?? null) : null);

  if (res.status === 401 && authenticated) {
    const refreshed = await refreshSession();
    if (refreshed) res = await call(refreshed.accessToken);
  }

  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Downloads a file answer of the API (for example an XBRL instance) under the given name.
export async function download(path: string, fileName: string): Promise<void> {
  const call = (token: string | null) => send(path, 'GET', undefined, token);
  let res = await call(sessionStore.get()?.accessToken ?? null);
  if (res.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) res = await call(refreshed.accessToken);
  }
  if (!res.ok) throw await readError(res);
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
