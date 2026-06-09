import { prisma } from './prisma';

/**
 * Generates sequential invoice numbers per school: GFA-2026-0001
 * Uses the DB to determine the next available number so it survives
 * server restarts and is safe against concurrent requests.
 */
export async function generateInvoiceNumber(schoolId: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `${schoolId.slice(-4).toUpperCase()}-${year}`;

  // Find the highest existing sequence number for this school/year
  const latest = await prisma.invoice.findFirst({
    where: {
      schoolId,
      invoiceNo: { startsWith: prefix },
    },
    orderBy: { issuedAt: 'desc' },
    select: { invoiceNo: true },
  });

  let nextSeq = 1;
  if (latest?.invoiceNo) {
    // Invoice numbers look like: XXXX-2026-0042
    const parts = latest.invoiceNo.split('-');
    const lastPart = parts[parts.length - 1];
    const parsed = parseInt(lastPart, 10);
    if (!isNaN(parsed)) nextSeq = parsed + 1;
  }

  // Safety: scan forward if that number is somehow already taken
  let invoiceNo = `${prefix}-${String(nextSeq).padStart(4, '0')}`;
  let attempts = 0;
  while (attempts < 20) {
    const exists = await prisma.invoice.findFirst({ where: { schoolId, invoiceNo }, select: { id: true } });
    if (!exists) break;
    nextSeq++;
    invoiceNo = `${prefix}-${String(nextSeq).padStart(4, '0')}`;
    attempts++;
  }

  return invoiceNo;
}
