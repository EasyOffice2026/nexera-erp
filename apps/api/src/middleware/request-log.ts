import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

// An id the caller may give (a proxy in front, for instance) is kept when it looks like one.
const GIVEN_ID = /^[A-Za-z0-9._-]{8,64}$/;

export interface LogLine {
  time: string;
  level: 'info' | 'warn' | 'error';
  requestId: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  ip: string | null;
}

// One line of JSON per request, for the host's log viewer, and an X-Request-Id header that ties
// an answer to its line. The path goes without its query, and no
// header, body or token is written. The health checks are left out.
export function requestLog(write: (line: LogLine) => void): RequestHandler {
  return (req, res, next) => {
    const given = req.get('x-request-id');
    const requestId = given && GIVEN_ID.test(given) ? given : randomUUID();
    res.locals.requestId = requestId;
    res.set('X-Request-Id', requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0] ?? '';
      if (path.startsWith('/api/v1/health')) return;
      write({
        time: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        ip: req.ip ?? null,
      });
    });
    next();
  };
}

export const writeJsonLine = (line: object) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};
