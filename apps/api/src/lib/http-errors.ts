// An error the API answers on purpose, with a status code and an error code from the spec.
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: unknown; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export const errors = {
  validation: (details: unknown) =>
    new AppError(400, 'VALIDATION_ERROR', 'The request is not valid', { details }),
  invalidCredentials: () =>
    new AppError(401, 'INVALID_CREDENTIALS', 'The credentials are not correct'),
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue'),
  tokenExpired: () => new AppError(401, 'TOKEN_EXPIRED', 'The access token has expired'),
  invalidRefreshToken: () =>
    new AppError(401, 'INVALID_REFRESH_TOKEN', 'The session is no longer valid. Sign in again'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'You do not have permission to do this'),
  notFound: (what: string) => new AppError(404, 'NOT_FOUND', `${what} was not found`),
  // The code says what is taken, for example EMAIL_TAKEN.
  conflict: (code: string, message: string) => new AppError(409, code, message),
  // The request is understood but breaks a bookkeeping rule, for example an unbalanced journal.
  rule: (code: string, message: string, details?: unknown) =>
    new AppError(422, code, message, details === undefined ? {} : { details }),
  // A terminal asked to sign somebody in at a branch (or a brand) that has been deactivated.
  branchInactive: () => new AppError(403, 'BRANCH_INACTIVE', 'This branch is not active'),
  // CRM holds its events until posting is turned on; FORBIDDEN would make it give up.
  postingDisabled: () =>
    new AppError(403, 'POSTING_DISABLED', 'Journal posting from CRM is turned off'),
  platformDisabled: () =>
    new AppError(403, 'PLATFORM_DISABLED', 'Platform provisioning is turned off'),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later', {
      details: { retryAfterSeconds },
      headers: { 'Retry-After': String(retryAfterSeconds) },
    }),
  accountLocked: (retryAfterSeconds: number) =>
    new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later', {
      details: { retryAfterSeconds },
      headers: { 'Retry-After': String(retryAfterSeconds) },
    }),
};
