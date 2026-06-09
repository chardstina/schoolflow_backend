/**
 * Payment Proof Routes
 * POST /payment-proofs                — parent uploads a receipt
 * GET  /payment-proofs                — parent: own proofs; admin: all pending proofs
 * POST /payment-proofs/:id/approve    — admin approves → creates Payment, updates Invoice
 * POST /payment-proofs/:id/reject     — admin rejects with reason
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate, resolveTenant, requireRole } from '../middleware/auth';
import { Role, PaymentChannel, InvoiceStatus, ProofStatus } from '@prisma/client';
import { auditLog } from '../utils/audit';
import { formatNaira } from '../utils/currency';

const router = Router();
router.use(authenticate, resolveTenant);

// ── Parent: upload receipt ────────────────────────────────────

router.post('/', requireRole(Role.PARENT), async (req: Request, res: Response) => {
  const { invoiceId, imageData, amountNaira, description } = req.body;

  if (!invoiceId || !imageData || !amountNaira) {
    return res.status(400).json({ error: 'invoiceId, imageData and amountNaira are required' });
  }
  if (!imageData.startsWith('data:image/')) {
    return res.status(400).json({ error: 'imageData must be a base64 image data URL' });
  }
  if (imageData.length > 5_000_000) {
    return res.status(400).json({ error: 'Image too large — maximum 3MB' });
  }

  // Verify the invoice belongs to this parent's child
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, schoolId: req.schoolId! },
    include: { student: { include: { parent: true } } },
  });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  const parentProfile = await prisma.parentProfile.findUnique({ where: { userId: req.user!.userId } });
  if (!parentProfile || invoice.student.parentId !== parentProfile.id) {
    return res.status(403).json({ error: 'This invoice does not belong to your child' });
  }

  if (invoice.status === InvoiceStatus.PAID) {
    return res.status(400).json({ error: 'Invoice is already fully paid' });
  }

  const amountKobo = Math.round(parseFloat(amountNaira) * 100);

  const proof = await prisma.paymentProof.create({
    data: {
      schoolId: req.schoolId!,
      invoiceId,
      uploadedBy: req.user!.userId,
      imageData,
      amountKobo,
      description: description || null,
      status: ProofStatus.PENDING,
    },
    include: { invoice: { select: { invoiceNo: true } } },
  });

  return res.status(201).json({
    proof,
    message: 'Receipt uploaded successfully. Awaiting admin approval.',
  });
});

// ── List proofs ───────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const { status, invoiceId } = req.query;

  // Parents see only their own submissions
  if (req.user?.role === Role.PARENT) {
    const parentProfile = await prisma.parentProfile.findUnique({ where: { userId: req.user!.userId } });
    if (!parentProfile) return res.json([]);

    const proofs = await prisma.paymentProof.findMany({
      where: {
        schoolId: req.schoolId!,
        invoice: { student: { parentId: parentProfile.id } },
        ...(status ? { status: status as ProofStatus } : {}),
      },
      include: {
        invoice: {
          include: { student: { select: { firstName: true, lastName: true, admissionNo: true } }, term: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(proofs);
  }

  // Admin / accountant see all
  const proofs = await prisma.paymentProof.findMany({
    where: {
      schoolId: req.schoolId!,
      ...(status ? { status: status as ProofStatus } : {}),
      ...(invoiceId ? { invoiceId: String(invoiceId) } : {}),
    },
    include: {
      invoice: {
        include: {
          student: { select: { firstName: true, lastName: true, admissionNo: true, class: { select: { name: true } } } },
          term: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  return res.json(proofs);
});

// ── Admin: approve receipt ────────────────────────────────────

router.post('/:id/approve', requireRole(Role.SCHOOL_ADMIN, Role.ACCOUNTANT), async (req: Request, res: Response) => {
  const proof = await prisma.paymentProof.findFirst({
    where: { id: req.params.id, schoolId: req.schoolId! },
    include: { invoice: true },
  });
  if (!proof) return res.status(404).json({ error: 'Proof not found' });
  if (proof.status !== ProofStatus.PENDING) {
    return res.status(400).json({ error: `Proof is already ${proof.status.toLowerCase()}` });
  }

  const invoice = proof.invoice;
  const PLATFORM_CUT_PCT = parseFloat(process.env.PLATFORM_CUT_PCT ?? '2.5');

  await prisma.$transaction(async (tx) => {
    // Mark proof approved
    await tx.paymentProof.update({
      where: { id: proof.id },
      data: { status: ProofStatus.APPROVED, reviewedBy: req.user!.userId, reviewedAt: new Date() },
    });

    // Create payment record
    const platformCutKobo = Math.round(proof.amountKobo * (PLATFORM_CUT_PCT / 100));
    const payment = await tx.payment.create({
      data: {
        schoolId: req.schoolId!,
        invoiceId: invoice.id,
        amountKobo: proof.amountKobo,
        platformCutKobo,
        schoolReceivesKobo: proof.amountKobo - platformCutKobo,
        channel: PaymentChannel.BANK_TRANSFER,
        recordedBy: req.user!.userId,
        paidAt: new Date(),
      },
    });

    // Update invoice balances
    const newPaid = invoice.paidKobo + proof.amountKobo;
    const newBalance = Math.max(0, invoice.totalKobo - newPaid);
    const newStatus = newBalance === 0 ? InvoiceStatus.PAID
      : newPaid > 0 ? InvoiceStatus.PARTIAL
      : InvoiceStatus.ISSUED;

    await tx.invoice.update({
      where: { id: invoice.id },
      data: { paidKobo: newPaid, balanceKobo: newBalance, status: newStatus },
    });

    // Audit log
    await tx.auditLog.create({
      data: {
        schoolId: req.schoolId!,
        userId: req.user!.userId,
        action: 'PAYMENT_PROOF_APPROVED',
        entityType: 'PaymentProof',
        entityId: proof.id,
        paymentId: payment.id,
        metadata: {
          amount: formatNaira(proof.amountKobo / 100),
          invoiceNo: invoice.invoiceNo,
        },
      },
    });
  });

  return res.json({ message: 'Receipt approved. Payment recorded and invoice updated.' });
});

// ── Admin: reject receipt ────────────────────────────────────

router.post('/:id/reject', requireRole(Role.SCHOOL_ADMIN, Role.ACCOUNTANT), async (req: Request, res: Response) => {
  const { reason } = req.body;
  const proof = await prisma.paymentProof.findFirst({
    where: { id: req.params.id, schoolId: req.schoolId! },
  });
  if (!proof) return res.status(404).json({ error: 'Proof not found' });

  await prisma.paymentProof.update({
    where: { id: proof.id },
    data: {
      status: ProofStatus.REJECTED,
      reviewedBy: req.user!.userId,
      reviewedAt: new Date(),
      rejectReason: reason || 'Rejected by admin',
    },
  });

  return res.json({ message: 'Receipt rejected.' });
});

export default router;
