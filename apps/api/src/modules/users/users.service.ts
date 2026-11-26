import type { CreateUserInput, Role, UpdateUserInput } from '@nexera/shared';
import { writeAudit } from '../../lib/audit';
import { errors } from '../../lib/http-errors';
import type { PasswordHasher } from '../../lib/password';
import type { PrismaClient } from '../../lib/prisma';
import type { Actor } from '../../middleware/authenticate';
import { Prisma } from '../../generated/prisma/client';

export interface UserView {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  language: 'en' | 'ar';
  isActive: boolean;
  lastLoginAt: string | null;
}

const select = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  language: true,
  isActive: true,
  lastLoginAt: true,
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof select }>;

function toView(user: UserRow): UserView {
  return { ...user, lastLoginAt: user.lastLoginAt?.toISOString() ?? null };
}

export function createUsersService(deps: { prisma: PrismaClient; hasher: PasswordHasher }) {
  const { prisma, hasher } = deps;

  return {
    async list(actor: Actor): Promise<UserView[]> {
      const users = await prisma.user.findMany({
        where: { tenantId: actor.tenantId },
        select,
        orderBy: { fullName: 'asc' },
      });
      return users.map(toView);
    },

    async create(actor: Actor, input: CreateUserInput): Promise<UserView> {
      const passwordHash = await hasher.hash(input.password);
      try {
        const user = await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              tenantId: actor.tenantId,
              email: input.email,
              fullName: input.fullName,
              role: input.role,
              language: input.language,
              passwordHash,
            },
            select,
          });
          await writeAudit(tx, {
            tenantId: actor.tenantId,
            userId: actor.userId,
            action: 'user.create',
            entityType: 'user',
            entityId: user.id,
            data: { email: user.email, role: user.role },
            ip: actor.ip,
          });
          return user;
        });
        return toView(user);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw errors.conflict('EMAIL_TAKEN', 'A user with this email already exists');
        }
        throw error;
      }
    },

    async update(actor: Actor, id: string, input: UpdateUserInput): Promise<UserView> {
      // Nobody can lock themselves out by demoting or deactivating their own account.
      if (
        id === actor.userId &&
        (input.isActive === false || (input.role && input.role !== 'owner'))
      ) {
        throw errors.conflict('SELF_CHANGE', 'You cannot remove your own owner access');
      }
      const passwordHash = input.password ? await hasher.hash(input.password) : undefined;
      const revokeSessions = input.isActive === false || Boolean(passwordHash);
      const user = await prisma.$transaction(async (tx) => {
        const existing = await tx.user.findFirst({
          where: { id, tenantId: actor.tenantId },
          select: { id: true },
        });
        if (!existing) throw errors.notFound('User');
        const user = await tx.user.update({
          where: { id, tenantId: actor.tenantId },
          data: {
            fullName: input.fullName,
            role: input.role,
            isActive: input.isActive,
            language: input.language,
            ...(passwordHash ? { passwordHash } : {}),
            ...(revokeSessions ? { sessionVersion: { increment: 1 } } : {}),
          },
          select,
        });
        if (revokeSessions) {
          await tx.refreshToken.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        await writeAudit(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'user.update',
          entityType: 'user',
          entityId: id,
          data: {
            role: input.role ?? null,
            isActive: input.isActive ?? null,
            password: Boolean(input.password),
          },
          ip: actor.ip,
        });
        return user;
      });
      return toView(user);
    },
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
