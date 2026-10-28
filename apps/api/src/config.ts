import { z } from 'zod';
import type { HashProfileName } from './lib/password';

// Development defaults match docker-compose.yml. Production must set its own values.
const DEV_DATABASE_URL = 'postgresql://nexera:nexera@localhost:5432/nexera';
const DEV_JWT_SECRET = 'dev-only-access-token-secret-do-not-use-in-production';

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  // Number of reverse proxies in front of the API (0 when none). Needed for correct client IPs.
  trustProxy: number;
  passwordHashProfile: HashProfileName;
  accessToken: { secret: string; ttlSeconds: number };
  refreshToken: { ttlDays: number; cookieName: string; cookieSecure: boolean };
  // Failed sign-in or refresh requests allowed per IP address in the window.
  authRateLimit: { windowMs: number; max: number };
  // The built web app, served by the API in production. Not served when unset.
  webDist: string | undefined;
  crmPostingEnabled: boolean;
  // Server-to-server provisioning of hosted CRM workspaces. Off unless turned on.
  platform: {
    provisioningEnabled: boolean;
    // Key id and SHA-256 hex of each full provider token (nxp_<keyId>_<secret>).
    apiKeys: { keyId: string; tokenSha256: string }[];
    // Calls allowed per key per minute.
    rateLimitPerMinute: number;
  };
}

const PLATFORM_KEY = /^([A-Za-z0-9]{1,32}):([0-9a-f]{64})$/;

function parsePlatformKeys(value: string): { keyId: string; tokenSha256: string }[] {
  const keys = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = PLATFORM_KEY.exec(entry);
      if (!match?.[1] || !match[2]) {
        throw new Error('PLATFORM_API_KEYS must be a comma list of keyId:sha256hex.');
      }
      return { keyId: match[1], tokenSha256: match[2] };
    });
  if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
    throw new Error('PLATFORM_API_KEYS has a key id twice.');
  }
  return keys;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';

  const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: production ? z.string().min(1) : z.string().min(1).default(DEV_DATABASE_URL),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    PASSWORD_HASH_PROFILE: z.enum(['standard', 'fast']).default('standard'),
    JWT_ACCESS_SECRET: production ? z.string().min(32) : z.string().min(32).default(DEV_JWT_SECRET),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .default(15 * 60),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(7),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
    WEB_DIST: z.string().min(1).optional(),
    CRM_INTEGRATION_POSTING_ENABLED: z.enum(['true', 'false']).default('false'),
    PLATFORM_PROVISIONING_ENABLED: z.enum(['true', 'false']).default('false'),
    PLATFORM_API_KEYS: z.string().default(''),
    PLATFORM_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  });

  const values = schema.parse(env);
  if (production && values.PASSWORD_HASH_PROFILE !== 'standard') {
    throw new Error('PASSWORD_HASH_PROFILE must be "standard" in production.');
  }
  // The development secret is in the code for everyone to read; anyone could sign tokens with it.
  if (production && values.JWT_ACCESS_SECRET === DEV_JWT_SECRET) {
    throw new Error('JWT_ACCESS_SECRET must be a secret of your own in production.');
  }

  const platformKeys = parsePlatformKeys(values.PLATFORM_API_KEYS);
  if (values.PLATFORM_PROVISIONING_ENABLED === 'true' && platformKeys.length === 0) {
    throw new Error('PLATFORM_PROVISIONING_ENABLED needs at least one PLATFORM_API_KEYS entry.');
  }

  return {
    nodeEnv: values.NODE_ENV,
    port: values.API_PORT,
    databaseUrl: values.DATABASE_URL,
    trustProxy: values.TRUST_PROXY,
    passwordHashProfile: values.PASSWORD_HASH_PROFILE,
    accessToken: { secret: values.JWT_ACCESS_SECRET, ttlSeconds: values.ACCESS_TOKEN_TTL_SECONDS },
    refreshToken: {
      ttlDays: values.REFRESH_TOKEN_TTL_DAYS,
      cookieName: 'nexera_refresh',
      cookieSecure: production,
    },
    authRateLimit: { windowMs: 15 * 60 * 1000, max: values.AUTH_RATE_LIMIT_MAX },
    webDist: values.WEB_DIST,
    crmPostingEnabled: values.CRM_INTEGRATION_POSTING_ENABLED === 'true',
    platform: {
      provisioningEnabled: values.PLATFORM_PROVISIONING_ENABLED === 'true',
      apiKeys: platformKeys,
      rateLimitPerMinute: values.PLATFORM_RATE_LIMIT_MAX,
    },
  };
}
