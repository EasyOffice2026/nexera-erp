import type { RequestHandler } from 'express';

// Headers on every answer of the API. It answers only JSON, which must never be run, framed or cached.
export function securityHeaders({ https }: { https: boolean }): RequestHandler {
  return (_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
      // Behind HTTPS only: the browser then never tries plain HTTP for a year.
      ...(https ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    });
    next();
  };
}
