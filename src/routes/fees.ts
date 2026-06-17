/**
 * Fee Management Routes
 * POST /fees/structures          — define fee items per class/term
 * POST /fees/invoices/generate   — bulk-generate invoices for a class/term
 * GET  /fees/invoices/:id        — get single invoice
 * GET  /fees/invoices            — list invoices (filter by class/term/status)
 * POST /fees/invoices/:id/void   — void an invoice (accountant / admin)
 * POST /fees/pay/initialize      — initiate Paystack checkout for parent
 * POST /fees/pay/verify          — verify after redirect
 * POST /fees/pay/webhook         — Paystack server-to-server event
 * POST /fees/pay/cash            — record manual cash payment
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import { authenticate, resolveTenant, requireRole, requireActiveSubscription } from '../middleware/auth';
import { Role, InvoiceStatus, PaymentChannel, FeeCategory } from '@prisma/client';
import { sendPaymentReminder } from '../services/notifications';
import { generateInvoiceNumber } from '../utils/invoiceNumber';
import { auditLog } from '../utils/audit';
import { formatNaira } from '../utils/currency';

const router = Router();
router.use(authenticate, resolveTenant, requireActiveSubscription);

// ── Fee Structures ──────────────────────────────────────

const feeStructureSchema = z.object({
  termId: z.string(),
  classId: z.string().optional(),
  category: z.nativeEnum(FeeCategory),
  description: z.string(),
  amountNaira: z.number().positive(),
  isCompulsory: z.boolean().default(true),
});

router.post(
  '/structures',
  requireRole(Role.SCHOOL_ADMIN, Role.ACCOUNTANT),
  async (req: Request, res: Response) => {
    const parse = feeStructureSchema.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });

    const { amountNaira, termId, classId, category, description, isCompulsory } = parse.data;

    const structure = await prisma.feeStructure.create({
      data: {
        schoolId: req.schoolId!,
        termId,
        classId,
        category,
        description,
        isCompulsory,
        amountKobo: Math.round(amountNaira * 100),
      },
    });

    return res.status(201).json(structure);
  }
);

router.get('/structures', async (req: Request, res: Response) => {
  const { termId, classId } = req.query;
  const structures = await prisma.feeStructure.findMany({
    where: {
      schoolId: req.schoolId!,
      ...(termId ? { termId: String(termId) } : {}),
      ...(classId ? { OR: [{ classId: String(classId) }, { classId: null }] } : {}),
    },
    include: { term: true, class: true },
    orderBy: { category: 'asc' },
  });
  return res.json(structures);
});

// ── Invoice Generation ──────────────────────────────────

router.post(
  '/invoices/generate',
  requireRole(Role.SCHOOL_ADMIN, Role.ACCOUNTANT),
  async (req: Request, res: Response) => {
    const { termId, classId } = req.body;
    if (!termId) return res.status(400).json({ error: 'termId required' });

    // Fetch fee structures for this term/class
    const structures = await prisma.feeStructure.findMany({
      where: {
        schoolId: req.schoolId!,
        termId,
        OR: [{ classId: classId ?? null }, { classId: null }],
        isCompulsory: true,
      },
    });

    if (!structures.length) {
      return res.status(400).json({ error: 'No fee structures found for this term/class' });
    }

    // Fetch students
    const students = await prisma.student.findMany({
      where: {
        schoolId: req.schoolId!,
        isActive: true,
        ...(classId ? { classId } : {}),
      },
    });

    if (!students.length) return res.status(400).json({ error: 'No active students found' });

    // Get term for due date
    const term = await prisma.term.findUnique({ where: { id: termId } });
    if (!term) return res.status(404).json({ error: 'Term not found' });

    const dueDate = new Date(term.startDate);
    dueDate.setDate(dueDate.getDate() + 21); // 3-week payment window

    // Sequential generation to avoid duplicate invoice numbers
    const invoices: any[] = [];
    let created = 0;
    let skipped = 0;

    for (const student of students) {
      // Skip if invoice already exists for this term
      const existing = await prisma.invoice.findFirst({
        where: { schoolId: req.schoolId!, studentId: student.id, termId },
      });
      if (existing) { invoices.push(existing); skipped++; continue; }

      const invoiceNo = await generateInvoiceNumber(req.schoolId!);
      const totalKobo = structures.reduce((s, f) => s + f.amountKobo, 0);

      const invoice = await prisma.invoice.create({
        data: {
          schoolId: req.schoolId!,
          studentId: student.id,
          termId,
          invoiceNo,
          totalKobo,
          paidKobo: 0,
          balanceKobo: totalKobo,
          status: InvoiceStatus.ISSUED,
          dueDate,
          items: {
            create: structures.map((s) => ({
              feeStructureId: s.id,
              description: s.description,
              amountKobo: s.amountKobo,
            })),
          },
        },
        include: { student: true, items: true },
      });
      invoices.push(invoice);
      created++;
    }

    return res.status(201).json({
      generated: created,
      skipped,
      total: invoices.length,
      invoices: invoices.slice(0, 10),
    });
  }
);

router.get('/invoices', async (req: Request, res: Response) => {
  const { termId, classId, status, studentId } = req.query;

  // PARENT: can only see their own children's invoices
  let allowedStudentIds: string[] | null = null;
  if (req.user?.role === Role.PARENT) {
    const profile = await prisma.parentProfile.findUnique({
      where: { userId: req.user.userId },
      include: { children: { select: { id: true } } },
    });
    allowedStudentIds = profile?.children.map(c => c.id) ?? [];
    // If a specific studentId was requested, verify it belongs to this parent
    if (studentId && !allowedStudentIds.includes(String(studentId))) {
      return res.status(403).json({ error: 'Access denied to this student\'s invoices' });
    }
  }

  const invoices = await prisma.invoice.findMany({
    where: {
      schoolId: req.schoolId!,
      // Parent scoping: only their children; if specific studentId requested by parent, use that
      ...(allowedStudentIds !== null
        ? { studentId: studentId ? String(studentId) : { in: allowedStudentIds } }
        : studentId ? { studentId: String(studentId) } : {}),
      ...(termId ? { termId: String(termId) } : {}),
      ...(status ? { status: status as InvoiceStatus } : {}),
      ...(classId && !allowedStudentIds ? { student: { classId: String(classId) } } : {}),
    },
    include: {
      student: { select: { firstName: true, lastName: true, admissionNo: true, class: true } },
      term: true,
      items: true,
      payments: { select: { amountKobo: true, paidAt: true, channel: true } },
    },
    orderBy: { issuedAt: 'desc' },
  });
  return res.json(invoices);
});

router.get('/invoices/:id', async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findFirst({
    where: { id: req.params.id, schoolId: req.schoolId! },
    include: {
      student: { include: { class: true, parent: { include: { user: true } } } },
      term: true,
      items: { include: { feeStructure: true } },
      payments: true,
    },
  });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  return res.json(invoice);
});

router.post(
  '/invoices/:id/void',
  requireRole(Role.SCHOOL_ADMIN, Role.ACCOUNTANT),
  async (req: Request, res: Response) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, schoolId: req.schoolId! },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.paidKobo > 0)
      return res.status(400).json({ error: 'Cannot void a partially or fully paid invoice' });

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.VOID },
    });

    await auditLog({
      schoolId: req.schoolId!,
      userId: req.user!.userId,
      action: 'INVOICE_VOIDED',
      entityType: 'Invoice',
      entityId: invoice.id,
      metadata: { invoiceNo: invoice.invoiceNo },
    });

    return res.json(updated);
  }
);

// ── Paystack Payment Flow ──────────────────────────

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY!;
const PLATFORM_CUT_PCT = parseFloat(process.env.PLATFORM_CUT_PCT ?? '2.5');

router.post('/pay/initialize', async (req: Request, res: Response) => {
  try {
  const { invoiceId, callbackUrl } = req.body;

  // Guard: require a real Paystack key
  if (!PAYSTACK_SECRET || PAYSTACK_SECRET === 'sk_test_placeholder') {
    return res.status(503).json({
      error: 'Online payment is not configured yet. Please add your Paystack secret key to the backend .env file (PAYSTACK_SECRET_KEY) and restart the server.',
    });
  }

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, schoolId: req.schoolId! },
    include: {
      student: { include: { parent: { include: { user: true } } } },
      school: true,
    },
  });

  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === InvoiceStatus.PAID) return res.status(400).json({ error: 'Already paid' });
  if (invoice.status === InvoiceStatus.VOID) return res.status(400).json({ error: 'Invoice voided' });

  const email = invoice.student.parent?.user.email ?? req.user!.email;
  const amountKobo = invoice.balanceKobo;

  // Split payment: school receives (100 - platformCut)%
  const paystackRes = await axios.post(
    'https://api.paystack.co/transaction/initialize',
    {
      email,
      amount: amountKobo, // Paystack amount is in kobo
      currency: 'NGN',
      reference: `SF-${invoice.invoiceNo}-${Date.now()}`,
      callback_url: callbackUrl,
      metadata: {
        invoiceId: invoice.id,
        schoolId: req.schoolId!,
        studentName: `${invoice.student.firstName} ${invoice.student.lastName}`,
      },
      // Split to school's sub-account
      ...(invoice.school.paystackSubAccount
        ? {
            split: {
              type: 'percentage',
              bearer_type: 'account',
              subaccounts: [
                {
                  subaccount: invoice.school.paystackSubAccount,
                  share: Math.round((100 - PLATFORM_CUT_PCT) * 100), // e.g. 9750 = 97.5%
                },
              ],
            },
          }
        : {}),
    },
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
  );

  return res.json(paystackRes.data.data);
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? 'Payment initialization failed';
    console.error('[Paystack initialize]', msg);
    return res.status(502).json({ error: `Payment gateway error: ${msg}` });
  }
});

router.post('/pay/verify', async (req: Request, res: Response) => {
  try {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'Reference required' });

  const verifyRes = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
  });

  const txn = verifyRes.data.data;
  if (txn.status !== 'success') return res.status(400).json({ error: 'Payment not successful' });

  await processPaystackPayment(txn);
  return res.json({ message: 'Payment recorded', reference });
  } catch (err: any) {
    const msg = err?.response?.data?.message ?? err?.message ?? 'Verification failed';
    console.error('[Paystack verify]', msg);
    return res.status(502).json({ error: `Payment gateway error: ${msg}` });
  }
});

// Paystack webhook — server-to-server
router.post('/pay/webhook', async (req: Request, res: Response) => {
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(400).send('Invalid signature');
  }

  const { event, data } = req.body;

  if (event === 'charge.success') {
    await processPaystackPayment(data);
  }

  return res.sendStatus(200);
});

async function processPaystackPayment(txn: any) {
  const { invoiceId, schoolId } = txn.metadata ?? {};
  if (!invoiceId || !schoolId) return;

  // Idempotency: skip if already recorded
  const existing = await prisma.payment.findUnique({
    where: { paystackReference: txn.reference },
  });
  if (existing) return;

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { school: true },
  });
  if (!invoice) return;

  const amountKobo = txn.amount as number;
  const platformCutKobo = Math.round(amountKobo * (PLATFORM_CUT_PCT / 100));
  const schoolReceivesKobo = amountKobo - platformCutKobo;

  const newPaid = invoice.paidKobo + amountKobo;
  const newBalance = invoice.totalKobo - newPaid;
  const newStatus =
    newBalance <= 0
      ? InvoiceStatus.PAID
      : newBalance < invoice.totalKobo
      ? InvoiceStatus.PARTIAL
      : InvoiceStatus.ISSUED;

  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        schoolId,
        invoiceId,
        amountKobo,
        platformCutKobo,
        schoolReceivesKobo,
        channel: PaymentChannel.PAYSTACK_CARD,
        paystackReference: txn.reference,
        paystackStatus: txn.status,
        paidAt: new Date(txn.paid_at),
      },
    });

    await tx.invoice.update({
      where: { id: invoiceId },
      data: { paidKobo: newPaid, balanceKobo: Math.max(newBalance, 0), status: newStatus },
    });

    // System user for audit (super-admin placeholder)
    const sysUser = await tx.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
    if (sysUser) {
      await tx.auditLog.create({
        data: {
          schoolId,
          userId: sysUser.id,
          action: 'PAYMENT_RECORDED',
          entityType: 'Payment',
          entityId: payment.id,
          paymentId: payment.id,
          metadata: {
            amount: formatNaira(amountKobo / 100),
            reference: txn.reference,
            channel: 'PAYSTACK',
          },
        },
      });
    }
  });
}

// ── Manual cash payment ──────────────────────────

router.post(
  '/pay/cash',
  requireRole(Role.ACCOUNTANT, Role.SCHOOL_ADMIN),
  async (req: Request, res: Response) => {
    const { invoiceId, amountNaira, note } = req.body;
    if (!invoiceId || !amountNaira) return res.status(400).json({ error: 'invoiceId and amountNaira required' });

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, schoolId: req.schoolId! },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const amountKobo = Math.round(amountNaira * 100);

    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          schoolId: req.schoolId!,
          invoiceId,
          amountKobo,
          platformCutKobo: 0,
          schoolReceivesKobo: amountKobo,
          channel: PaymentChannel.CASH,
          recordedBy: req.user!.userId,
        },
      });

      const newPaid = invoice.paidKobo + amountKobo;
      const newBalance = invoice.totalKobo - newPaid;
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          paidKobo: newPaid,
          balanceKobo: Math.max(newBalance, 0),
          status:
            newBalance <= 0
              ? InvoiceStatus.PAID
              : newBalance < invoice.totalKobo
              ? InvoiceStatus.PARTIAL
              : InvoiceStatus.ISSUED,
        },
      });

      await tx.auditLog.create({
        data: {
          schoolId: req.schoolId!,
          userId: req.user!.userId,
          action: 'CASH_PAYMENT_RECORDED',
          entityType: 'Payment',
          entityId: payment.id,
          paymentId: payment.id,
          metadata: { amount: formatNaira(amountNaira), note },
        },
      });
    });

    return res.json({ message: 'Cash payment recorded' });
  }
);

// ── Reminder dispatch ─────────────────────────

router.post(
  '/reminders/send',
  requireRole(Role.SCHOOL_ADMIN, Role.ACCOUNTANT),
  async (req: Request, res: Response) => {
    const { termId, daysOverdue } = req.body;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (daysOverdue ?? 0));

    const owing = await prisma.invoice.findMany({
      where: {
        schoolId: req.schoolId!,
        termId,
        status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL, InvoiceStatus.OVERDUE] },
        dueDate: { lte: cutoff },
      },
      include: {
        student: {
          include: {
            class: true,
            parent: { include: { user: { select: { email: true, phone: true, firstName: true } } } },
          },
        },
        school: { select: { name: true } },
      },
    });

    const results = await Promise.allSettled(
      owing.map((inv) => sendPaymentReminder(inv))
    );

    const sent = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - sent;

    return res.json({ sent, failed, total: owing.length });
  }
);

export default router;
