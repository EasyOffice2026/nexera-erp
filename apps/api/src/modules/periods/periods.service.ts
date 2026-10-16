import type { CreateFiscalYearInput, FiscalYear, Period, PeriodStatus } from '@nexera/shared';
import { writeAudit } from '../../lib/audit';
import { findCompany } from '../../lib/company-scope';
import { addDays, addMonths, formatDate, parseDate } from '../../lib/dates';
import { errors } from '../../lib/http-errors';
import type { PrismaClient } from '../../lib/prisma';
import type { Actor } from '../../middleware/authenticate';
import type { Prisma } from '../../generated/prisma/client';

type PeriodRow = Prisma.PeriodGetPayload<object>;
type FiscalYearRow = Prisma.FiscalYearGetPayload<{ include: { periods: true } }>;

function toPeriod(row: PeriodRow): Period {
  return {
    id: row.id,
    number: row.number,
    startDate: formatDate(row.startDate),
    endDate: formatDate(row.endDate),
    status: row.status,
  };
}

function toFiscalYear(row: FiscalYearRow): FiscalYear {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    startDate: formatDate(row.startDate),
    endDate: formatDate(row.endDate),
    status: row.status,
    periods: [...row.periods].sort((a, b) => a.number - b.number).map(toPeriod),
  };
}

// "FY2026" for a calendar year, "FY2026/27" otherwise.
export function fiscalYearName(start: Date, end: Date): string {
  const first = start.getUTCFullYear();
  const last = end.getUTCFullYear();
  return first === last ? `FY${first}` : `FY${first}/${String(last).slice(-2)}`;
}

export function createPeriodsService(deps: { prisma: PrismaClient }) {
  const { prisma } = deps;

  return {
    async listFiscalYears(actor: Actor, companyId: string): Promise<FiscalYear[]> {
      await findCompany(prisma, actor.tenantId, companyId);
      const rows = await prisma.fiscalYear.findMany({
        where: { companyId },
        include: { periods: true },
        orderBy: { startDate: 'desc' },
      });
      return rows.map(toFiscalYear);
    },

    // Opens a financial year of 12 monthly periods. It starts the month after the company's
    // year-end month and may not overlap another year.
    async createFiscalYear(
      actor: Actor,
      companyId: string,
      input: CreateFiscalYearInput,
    ): Promise<FiscalYear> {
      const company = await findCompany(prisma, actor.tenantId, companyId);
      const start = parseDate(input.startDate);
      const expectedMonth = (company.fiscalYearEndMonth % 12) + 1;
      if (start.getUTCMonth() + 1 !== expectedMonth) {
        throw errors.rule(
          'FISCAL_YEAR_START_MISMATCH',
          'The financial year must start the month after the company year-end',
          { expectedMonth },
        );
      }
      const end = addDays(addMonths(start, 12), -1);

      const row = await prisma.$transaction(async (tx) => {
        const overlap = await tx.fiscalYear.findFirst({
          where: { companyId, startDate: { lte: end }, endDate: { gte: start } },
        });
        if (overlap) {
          throw errors.conflict('FISCAL_YEAR_OVERLAP', 'This financial year overlaps another one');
        }
        const year = await tx.fiscalYear.create({
          data: {
            tenantId: actor.tenantId,
            companyId,
            name: fiscalYearName(start, end),
            startDate: start,
            endDate: end,
            periods: {
              create: Array.from({ length: 12 }, (_, index) => ({
                tenantId: actor.tenantId,
                companyId,
                number: index + 1,
                startDate: addMonths(start, index),
                endDate: addDays(addMonths(start, index + 1), -1),
              })),
            },
          },
          include: { periods: true },
        });
        await writeAudit(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: 'fiscal_year.create',
          entityType: 'fiscal_year',
          entityId: year.id,
          data: { name: year.name },
          ip: actor.ip,
        });
        return year;
      });
      return toFiscalYear(row);
    },

    // Closing stops posting into the period; reopening allows it again. A period with draft
    // journals cannot be closed, so nothing is left half-done.
    async setPeriodStatus(
      actor: Actor,
      companyId: string,
      periodId: string,
      status: PeriodStatus,
    ): Promise<Period> {
      await findCompany(prisma, actor.tenantId, companyId);
      const row = await prisma.$transaction(async (tx) => {
        // Posting takes the same lock, so a journal cannot slip into a period being closed.
        await tx.company.update({
          where: { id: companyId },
          data: { journalSeq: { increment: 0 } },
        });
        const period = await tx.period.findFirst({ where: { id: periodId, companyId } });
        if (!period) throw errors.notFound('Period');
        if (status === 'CLOSED') {
          const drafts = await tx.journalEntry.count({ where: { periodId, status: 'DRAFT' } });
          if (drafts > 0) {
            throw errors.rule('PERIOD_HAS_DRAFTS', 'Post or delete the draft journals first', {
              drafts,
            });
          }
        }
        const updated = await tx.period.update({
          where: { id: periodId },
          data:
            status === 'CLOSED'
              ? { status, closedAt: new Date(), closedById: actor.userId }
              : { status, closedAt: null, closedById: null },
        });
        const open = await tx.period.count({
          where: { fiscalYearId: period.fiscalYearId, status: 'OPEN' },
        });
        await tx.fiscalYear.update({
          where: { id: period.fiscalYearId },
          data: { status: open === 0 ? 'CLOSED' : 'OPEN' },
        });
        await writeAudit(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          action: status === 'CLOSED' ? 'period.close' : 'period.reopen',
          entityType: 'period',
          entityId: periodId,
          ip: actor.ip,
        });
        return updated;
      });
      return toPeriod(row);
    },
  };
}

export type PeriodsService = ReturnType<typeof createPeriodsService>;
