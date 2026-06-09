import { prisma } from './prisma';

interface AuditParams {
  schoolId: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export async function auditLog(params: AuditParams): Promise<void> {
  await prisma.auditLog.create({ data: params }).catch((e) => console.error('[AuditLog]', e));
}
