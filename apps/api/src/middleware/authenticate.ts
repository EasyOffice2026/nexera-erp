import type { AccessTokenClaims, Permission } from '@nexera/shared';
import { hasPermission } from '@nexera/shared';
import type { Request, RequestHandler } from 'express';
import { errors } from '../lib/http-errors';
import type { TokenService } from '../lib/tokens';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AccessTokenClaims;
  }
}

// Reads the bearer token and puts the person's claims on the request.
export function authenticate(tokens: TokenService): RequestHandler {
  return async (req, _res, next) => {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw errors.unauthenticated();
    }
    req.auth = await tokens.verifyAccessToken(token);
    next();
  };
}

// Lets the request through only when the person's role grants every listed permission.
export function requirePermission(...needed: Permission[]): RequestHandler {
  return (req, _res, next) => {
    const role = req.auth?.role;
    if (!role) throw errors.unauthenticated();
    if (!needed.every((permission) => hasPermission(role, permission))) {
      throw errors.forbidden();
    }
    next();
  };
}

export interface Actor {
  userId: string;
  tenantId: string;
  ip: string | null;
}

// The person asking. Every service call is limited to their tenant.
export function actorOf(req: Request): Actor {
  if (!req.auth) throw errors.unauthenticated();
  return { userId: req.auth.sub, tenantId: req.auth.tenantId, ip: req.ip ?? null };
}
