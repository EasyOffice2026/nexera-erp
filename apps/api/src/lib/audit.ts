import type { Prisma } from '../generated/prisma/client';

type AuditClient = Pick<Prisma.TransactionClient, 'auditLog'>;

export interface AuditEvent {
  tenantId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Prisma.InputJsonObject;
  ip?: string | null;
}

// Appends a row to the audit log. Rows are never updated or deleted.
export function writeAudit(db: AuditClient, event: AuditEvent) {
  return db.auditLog.create({
    data: {
      tenantId: event.tenantId,
      userId: event.userId ?? null,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      data: event.data ?? {},
      ip: event.ip ?? null,
    },
  });
}
