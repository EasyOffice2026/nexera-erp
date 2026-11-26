import type { Session } from '@nexera/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ApiError(
      0,
      'The accounting service is unreachable. Try again when the connection is back.',
    );
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new ApiError(
      response.status,
      payload?.error?.message ?? 'The accounting service could not complete the request.',
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

let refreshing: Promise<Session> | undefined;

export function refreshSession() {
  refreshing ??= api<Session>('/auth/refresh', { method: 'POST' }).finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

const dinar = new Intl.NumberFormat('en-KW', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});
const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('en-GB', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

export const formatAmount = (amount: string) => dinar.format(amount as `${number}`);
export const formatDay = (date: string) => dateFormat.format(new Date(date));
export const formatMonth = (date: string) => monthFormat.format(new Date(date));
export const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kuwait' }).format(new Date());
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Try again.';
