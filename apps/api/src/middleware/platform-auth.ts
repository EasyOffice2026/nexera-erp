import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Config } from '../config';
import { AppError, errors } from '../lib/http-errors';

// nxp_<keyId>_<secret>. The key id has no underscore, so the first one after it ends it.
const PLATFORM_TOKEN = /^nxp_([A-Za-z0-9]{1,32})_([A-Za-z0-9_-]{16,256})$/;
const NO_KEY = Buffer.alloc(32);

// Authenticates the provider (the CRM provisioner) on /api/v1/platform. Only a platform key is
// accepted: user tokens and CRM service tokens are not. Browsers are turned away, so no
// workspace page can ever call these routes, and each key gets a fixed number of calls a minute.
export function platformAuth(config: Config, now: () => Date = () => new Date()): RequestHandler {
  const keys = new Map(
    config.platform.apiKeys.map((key) => [key.keyId, Buffer.from(key.tokenSha256, 'hex')]),
  );
  const windows = new Map<string, { started: number; count: number }>();
  const windowMs = 60_000;

  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!config.platform.provisioningEnabled) throw errors.platformDisabled();
    if (req.get('origin') !== undefined || req.get('cookie') !== undefined) {
      throw new AppError(403, 'FORBIDDEN', 'The platform API is for servers only');
    }
    const [scheme, token, extra] = (req.headers.authorization ?? '').split(' ');
    const match =
      scheme?.toLowerCase() === 'bearer' && !extra ? PLATFORM_TOKEN.exec(token ?? '') : null;
    const keyId = match?.[1];
    const expected = (keyId && keys.get(keyId)) || NO_KEY;
    const given = createHash('sha256')
      .update(token ?? '')
      .digest();
    if (!timingSafeEqual(given, expected) || !keyId || expected === NO_KEY) {
      throw errors.unauthenticated();
    }

    const at = now().getTime();
    const window = windows.get(keyId);
    if (!window || at - window.started >= windowMs) {
      windows.set(keyId, { started: at, count: 1 });
    } else if (window.count >= config.platform.rateLimitPerMinute) {
      throw errors.rateLimited(Math.max(1, Math.ceil((window.started + windowMs - at) / 1000)));
    } else {
      window.count += 1;
    }
    res.locals.platformKeyId = keyId;
    next();
  };
}
