import {
  type LoginRequest,
  type Role,
  rolePermissions,
  type Session,
  type SessionUser,
} from '@nexera/shared';
import type { Config } from '../../config';
import { writeAudit } from '../../lib/audit';
import { errors } from '../../lib/http-errors';
import type { PasswordHasher } from '../../lib/password';
import type { PrismaClient } from '../../lib/prisma';
import type { RequestMeta } from '../../lib/request-meta';
import { generateRefreshToken, hashRefreshToken, type TokenService } from '../../lib/tokens';

export interface LoginResult {
  session: Session;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface AuthService {
  login(input: LoginRequest, meta: RequestMeta): Promise<LoginResult>;
  refresh(token: string | undefined): Promise<LoginResult>;
  logout(token: string | undefined): Promise<void>;
  me(userId: string, tenantId: string): Promise<SessionUser>;
}

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  language: 'en' | 'ar';
  tenant: { id: string; slug: string; name: string };
}

function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    language: user.language,
    tenant: user.tenant,
    permissions: [...rolePermissions[user.role]],
  };
}

const userSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  language: true,
  tenant: { select: { id: true, slug: true, name: true } },
} as const;

export function createAuthService(deps: {
  prisma: PrismaClient;
  hasher: PasswordHasher;
  tokens: TokenService;
  config: Config;
}): AuthService {
  const { prisma, hasher, tokens, config } = deps;

  async function issue(user: UserRow): Promise<LoginResult> {
    const { token, hash } = generateRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + config.refreshToken.ttlDays * 86_400_000);
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt: refreshExpiresAt },
    });
    const accessToken = await tokens.signAccessToken({
      sub: user.id,
      tenantId: user.tenant.id,
      role: user.role,
    });
    return {
      session: { accessToken, expiresIn: config.accessToken.ttlSeconds, user: toSessionUser(user) },
      refreshToken: token,
      refreshExpiresAt,
    };
  }

  return {
    async login(input, meta) {
      const user = await prisma.user.findFirst({
        where: { email: input.email, tenant: { slug: input.tenant } },
        select: {
          ...userSelect,
          passwordHash: true,
          isActive: true,
          tenant: { select: { id: true, slug: true, name: true, isActive: true } },
        },
      });
      if (!user) {
        await hasher.verifyDummy(input.password);
        throw errors.invalidCredentials();
      }
      const valid = await hasher.verify(input.password, user.passwordHash);
      if (!valid || !user.isActive || !user.tenant.isActive) {
        throw errors.invalidCredentials();
      }
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await writeAudit(prisma, {
        tenantId: user.tenant.id,
        userId: user.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        ip: meta.ip,
      });
      return issue(user);
    },

    async refresh(token) {
      if (!token) throw errors.invalidRefreshToken();
      const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashRefreshToken(token) },
        include: {
          user: {
            select: {
              ...userSelect,
              isActive: true,
              tenant: { select: { ...userSelect.tenant.select, isActive: true } },
            },
          },
        },
      });
      if (
        !stored ||
        stored.revokedAt ||
        stored.expiresAt <= new Date() ||
        !stored.user.isActive ||
        !stored.user.tenant.isActive
      ) {
        throw errors.invalidRefreshToken();
      }
      // Each refresh token is used once; the next one replaces it.
      await prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });
      return issue(stored.user);
    },

    async logout(token) {
      if (!token) return;
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    },

    async me(userId, tenantId) {
      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId, isActive: true },
        select: userSelect,
      });
      if (!user) throw errors.unauthenticated();
      return toSessionUser(user);
    },
  };
}
