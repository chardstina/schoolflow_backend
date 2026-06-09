/**
 * Subscription Billing Module
 *
 * Tiers (by active student count):
 *   STARTER    ≤  150  →  ₦15,000/month
 *   GROWTH     ≤  500  →  ₦25,000/month
 *   SCALE      ≤ 1500  →  ₦35,000/month
 *   ENTERPRISE unlimited →  ₦40,000/month
 *
 * Billing flow:
 *  1. School onboards → 30-day TRIAL
 *  2. Trial ends → email invoice, charge via Paystack recurring
 *  3. Payment success → activate for next 30 days
 *  4. Payment fails → PAST_DUE; 7-day grace period, then suspend
 *  5. Cron job runs daily to check expiring subscriptions
 */

import { Router, Request, Response } from 'express';
import axios from 'axios';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { authenticate, resolveTenant, requireRole } from '../middleware/auth';
import { Role, SubscriptionStatus, SubscriptionTier } from '@prisma/client';
import { sendEmail } from '../services/notifications';
import { auditLog } from '../utils/audit';
import { formatNaira } from '../utils/currency';

const router = Router();
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY!;

// ── Tier config ────────────────────────────────────────────────

export const TIERS: Record<SubscriptionTier, { label: string; maxStudents: number; monthlyNaira: number }> = {
  STARTER:    { label: 'Starter',    maxStudents: 150,        monthlyNaira: 15_000 },
  GROWTH:     { label: 'Growth',     maxStudents: 500,        monthlyNaira: 25_000 },
  SCALE:      { label: 'Scale',      maxStudents: 1_500,      monthlyNaira: 35_000 },
  ENTERPRISE: { label: 'Enterprise', maxStudents: 999_999,    monthlyNaira: 40_000 },
};

export function tierForStudentCount(count: number): SubscriptionTier {
  if (count <= 150) return SubscriptionTier.STARTER;
  if (count <= 500) return SubscriptionTier.GROWTH;
  if (count <= 1500) return SubscriptionTier.SCALE;
  return SubscriptionTier.ENTERPRISE;
}

// ── Get current subscription ──────────────────────────────────

router.get(
  '/',
  authenticate,
  resolveTenant,
  async (req: Request, res: Response) => {
    const sub = await prisma.subscription.findUnique({
      where: { schoolId: req.schoolId! },
    });
    if (!sub) return res.status(404).json({ error: 'No subscription found' });

    const studentCount = await prisma.student.count({
      where: { schoolId: req.schoolId!, isActive: true },
    });
    const recommendedTier = tierForStudentCount(studentCount);

    return res.json({ subscription: sub, studentCount, recommendedTier, tiers: TIERS });
  }
);

// ── Initialize billing (first time, after trial) ─────────────

router.post(
  '/initialize',
  authenticate,
  resolveTenant,
  requireRole(Role.SCHOOL_ADMIN, Role.SUPER_ADMIN),
  async (req: Request, res: Response) => {
    const { email, tier } = req.body;

    const tierConfig = TIERS[tier as SubscriptionTier];
    if (!tierConfig) return res.status(400).json({ error: 'Invalid tier' });

    // Create or fetch Paystack customer
    const customerRes = await axios.post(
      'https://api.paystack.co/customer',
      { email, first_name: req.schoolId },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );
    const customer = customerRes.data.data;

    // Initialize a Paystack transaction to get a reusable auth code
    const txnRes = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: tierConfig.monthlyNaira * 100, // kobo
        currency: 'NGN',
        customer: customer.customer_code,
        callback_url: `${process.env.APP_URL}/billing/callback`,
        metadata: { schoolId: req.schoolId!, billingSetup: true, tier },
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    return res.json({
      authorizationUrl: txnRes.data.data.authorization_url,
      reference: txnRes.data.data.reference,
      customer: customer.customer_code,
    });
  }
);

// ── Webhook: charge.success → activate subscription ───────────

router.post('/webhook', async (req: Request, res: Response) => {
  const { event, data } = req.body;

  if (event === 'charge.success') {
    const { schoolId, billingSetup, tier } = data.metadata ?? {};

    if (schoolId) {
      await activateSubscription(schoolId, tier, data.authorization?.authorization_code);
    }
  }

  if (event === 'subscription.not_renew' || event === 'invoice.payment_failed') {
    const email = data.customer?.email;
    if (email) {
      // Find school by email
      const user = await prisma.user.findFirst({ where: { email, role: Role.SCHOOL_ADMIN } });
      if (user?.schoolId) {
        await prisma.subscription.update({
          where: { schoolId: user.schoolId },
          data: { status: SubscriptionStatus.PAST_DUE },
        });
        await redis.del(`sub:${user.schoolId}`);
      }
    }
  }

  return res.sendStatus(200);
});

async function activateSubscription(schoolId: string, tier: SubscriptionTier, authCode?: string) {
  const tierConfig = TIERS[tier] ?? TIERS.STARTER;
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  await prisma.subscription.upsert({
    where: { schoolId },
    create: {
      schoolId,
      tier,
      status: SubscriptionStatus.ACTIVE,
      paystackAuthCode: authCode,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      monthlyAmountKobo: tierConfig.monthlyNaira * 100,
      studentLimit: tierConfig.maxStudents,
    },
    update: {
      status: SubscriptionStatus.ACTIVE,
      tier,
      paystackAuthCode: authCode ?? undefined,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      monthlyAmountKobo: tierConfig.monthlyNaira * 100,
      studentLimit: tierConfig.maxStudents,
    },
  });

  // Invalidate cache
  await redis.del(`sub:${schoolId}`);
  await redis.del(`school:${schoolId}:active`);

  // Notify admin
  const admin = await prisma.user.findFirst({
    where: { schoolId, role: Role.SCHOOL_ADMIN },
  });
  if (admin?.email) {
    await sendEmail(
      admin.email,
      `SchoolFlow — Subscription Activated (${tierConfig.label})`,
      `<p>Your SchoolFlow ${tierConfig.label} subscription is now active until ${periodEnd.toLocaleDateString('en-NG')}.</p>
       <p>Monthly fee: <strong>${formatNaira(tierConfig.monthlyNaira)}</strong></p>`
    ).catch(console.error);
  }
}

// ── Upgrade / downgrade tier ───────────────────────────────────

router.post(
  '/change-tier',
  authenticate,
  resolveTenant,
  requireRole(Role.SCHOOL_ADMIN),
  async (req: Request, res: Response) => {
    const { tier } = req.body;
    if (!TIERS[tier as SubscriptionTier]) return res.status(400).json({ error: 'Invalid tier' });

    const studentCount = await prisma.student.count({
      where: { schoolId: req.schoolId!, isActive: true },
    });

    const newConfig = TIERS[tier as SubscriptionTier];
    if (studentCount > newConfig.maxStudents) {
      return res.status(400).json({
        error: `Cannot downgrade: you have ${studentCount} students but ${newConfig.label} tier supports ${newConfig.maxStudents}`,
      });
    }

    const updated = await prisma.subscription.update({
      where: { schoolId: req.schoolId! },
      data: {
        tier: tier as SubscriptionTier,
        monthlyAmountKobo: newConfig.monthlyNaira * 100,
        studentLimit: newConfig.maxStudents,
      },
    });

    await redis.del(`sub:${req.schoolId!}`);

    await auditLog({
      schoolId: req.schoolId!,
      userId: req.user!.userId,
      action: 'SUBSCRIPTION_TIER_CHANGED',
      entityType: 'Subscription',
      entityId: updated.id,
      metadata: { tier, monthlyNaira: newConfig.monthlyNaira },
    });

    return res.json({ subscription: updated });
  }
);

// ── Cancel subscription ────────────────────────────────────────

router.post(
  '/cancel',
  authenticate,
  resolveTenant,
  requireRole(Role.SCHOOL_ADMIN),
  async (req: Request, res: Response) => {
    const sub = await prisma.subscription.update({
      where: { schoolId: req.schoolId! },
      data: { status: SubscriptionStatus.CANCELLED, cancelledAt: new Date() },
    });
    await redis.del(`sub:${req.schoolId!}`);
    return res.json({ message: 'Subscription cancelled', sub });
  }
);

// ── Admin: list all subscriptions ────────────────────────────

router.get(
  '/all',
  authenticate,
  requireRole(Role.SUPER_ADMIN),
  async (_req: Request, res: Response) => {
    const subs = await prisma.subscription.findMany({
      include: { school: { select: { name: true, slug: true, email: true } } },
      orderBy: { currentPeriodEnd: 'asc' },
    });
    const mrr = subs
      .filter((s) => s.status === SubscriptionStatus.ACTIVE)
      .reduce((t, s) => t + s.monthlyAmountKobo, 0);

    return res.json({ subscriptions: subs, mrr, mrrFormatted: formatNaira(mrr / 100) });
  }
);

export default router;
