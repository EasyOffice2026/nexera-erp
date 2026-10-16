import type { Request } from 'express';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

// Who is calling, for the audit log.
export function requestMeta(req: Request): RequestMeta {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 500) ?? null };
}
