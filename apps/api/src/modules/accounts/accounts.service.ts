import {
  type Account,
  type AccountSubtype,
  type CreateAccountInput,
  isSubtypeOf,
  type UpdateAccountInput,
} from '@nexera/shared';
import { writeAudit } from '../../lib/audit';
import { asName, findCompany } from '../../lib/company-scope';
import { errors } from '../../lib/http-errors';
import type { PrismaClient } from '../../lib/prisma';
import type { Actor } from '../../middleware/authenticate';
import { Prisma } from '../../generated/prisma/client';

type AccountRow = Prisma.AccountGetPayload<object>;

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: asName(row.name),
    type: row.type,
    subtype: row.subtype as AccountSubtype,
    parentId: row.parentId,
    isPostable: row.isPostable,
    isActive: row.isActive,
    taxonomyConcept: row.taxonomyConcept,
  };
}

export function createAccountsService(deps: { prisma: PrismaClient }) {
  const { prisma } = deps;

  // A parent is a header account of the same company and type.
  async function checkParent(companyId: string, type: AccountRow['type'], parentId: string) {
    const parent = await prisma.account.findFirst({ where: { id: parentId, companyId } });
    if (!parent) throw errors.notFound('Parent account');
    if (parent.isPostable) {
      throw errors.rule('PARENT_NOT_HEADER', 'The parent must be a header account');
    }
    if (parent.type !== type) {
      throw errors.rule('PARENT_TYPE_MISMATCH', 'The parent must be of the same account type');
    }
    return parent;
  }

  async function hasLines(accountId: string): Promise<boolean> {
    return (await prisma.journalLine.count({ where: { accountId }, take: 1 })) > 0;
  }

  async function findAccount(companyId: string, id: string) {
    const account = await prisma.account.findFirst({ where: { id, companyId } });
    if (!account) throw errors.notFound('Account');
    return account;
  }

  return {
    async list(actor: Actor, companyId: string): Promise<Account[]> {
      await findCompany(prisma, actor.tenantId, companyId);
      const rows = await prisma.account.findMany({
        where: { companyId },
        orderBy: { code: 'asc' },
      });
      return rows.map(toAccount);
    },

    async create(actor: Actor, companyId: string, input: CreateAccountInput): Promise<Account> {
      await findCompany(prisma, actor.tenantId, companyId);
      if (input.parentId) await checkParent(companyId, input.type, input.parentId);
      try {
        const row = await prisma.account.create({
          data: {
            tenantId: actor.tenantId,
            companyId,
            code: input.code,
            name: input.name,
            type: input.type,
            subtype: input.subtype,
            parentId: input.parentId,
            isPostable: input.isPostable,
            taxonomyConcept: input.taxonomyConcept,
          },
        });
        await writeAudit(prisma, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'account.create',
          entityType: 'account',
          entityId: row.id,
          data: { code: row.code },
          ip: actor.ip,
        });
        return toAccount(row);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw errors.conflict('ACCOUNT_CODE_TAKEN', 'An account with this code already exists');
        }
        throw error;
      }
    },

    async update(
      actor: Actor,
      companyId: string,
      id: string,
      input: UpdateAccountInput,
    ): Promise<Account> {
      await findCompany(prisma, actor.tenantId, companyId);
      const account = await findAccount(companyId, id);

      if (input.subtype !== undefined && !isSubtypeOf(account.type, input.subtype)) {
        throw errors.rule('INVALID_SUBTYPE', 'The subtype does not belong to the account type');
      }
      if (input.parentId) {
        // Walk up from the new parent: meeting this account would make a loop.
        let current: AccountRow | null = await checkParent(companyId, account.type, input.parentId);
        while (current) {
          if (current.id === id) {
            throw errors.rule('PARENT_CYCLE', 'An account cannot sit under itself');
          }
          current = current.parentId
            ? await prisma.account.findFirst({ where: { id: current.parentId, companyId } })
            : null;
        }
      }
      if (input.isPostable === false && account.isPostable && (await hasLines(id))) {
        throw errors.conflict('ACCOUNT_IN_USE', 'An account with journal lines must stay postable');
      }
      if (
        input.isPostable === true &&
        !account.isPostable &&
        (await prisma.account.count({ where: { parentId: id } })) > 0
      ) {
        throw errors.conflict(
          'ACCOUNT_HAS_CHILDREN',
          'A header with accounts under it cannot take lines',
        );
      }

      const row = await prisma.account.update({
        where: { id },
        data: {
          name: input.name,
          subtype: input.subtype,
          parentId: input.parentId,
          isPostable: input.isPostable,
          taxonomyConcept: input.taxonomyConcept,
          isActive: input.isActive,
        },
      });
      await writeAudit(prisma, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        action: 'account.update',
        entityType: 'account',
        entityId: id,
        data: { ...input },
        ip: actor.ip,
      });
      return toAccount(row);
    },

    // Only an account nobody has used can go. Others are deactivated instead.
    async remove(actor: Actor, companyId: string, id: string): Promise<void> {
      await findCompany(prisma, actor.tenantId, companyId);
      const account = await findAccount(companyId, id);
      if (await hasLines(id)) {
        throw errors.conflict('ACCOUNT_IN_USE', 'An account with journal lines cannot be deleted');
      }
      if ((await prisma.account.count({ where: { parentId: id } })) > 0) {
        throw errors.conflict('ACCOUNT_HAS_CHILDREN', 'Move or delete the accounts under it first');
      }
      await prisma.account.delete({ where: { id } });
      await writeAudit(prisma, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        action: 'account.delete',
        entityType: 'account',
        entityId: id,
        data: { code: account.code },
        ip: actor.ip,
      });
    },
  };
}

export type AccountsService = ReturnType<typeof createAccountsService>;
