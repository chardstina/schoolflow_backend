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
  const { schoolId, userId, action, entityType, entityId, metadata, ipAddress } = params;
  await prisma.auditLog.create({
    data: {
      schoolId,
      userId,
      action,
      entityType,
      entityId,
      metadata: metadata as any,
      ipAddress,
    },
  }).catch((e) => console.error('[AuditLog]', e));
}
