/**
 * Billing cron — runs daily via node-cron
 *
 * Tasks:
 *  1. Charge schools whose subscription is due today (recurring via Paystack)
 *  2. Flag PAST_DUE schools that exceeded 7-day grace → suspend
 *  3. Auto-upgrade tier if student count exceeds current plan limit
 *  4. Send upcoming renewal notices (3 days before)
 */

import cron from 'node-cron';
import axios from 'axios';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { SubscriptionStatus } from '@prisma/client';
import { TIERS, tierForStudentCount } from '../routes/subscriptions';
import { sendEmail } from '../services/notifications';
import { formatNaira } from '../utils/currency';

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY!;

// Daily at 08:00 WAT (UTC+1 → 07:00 UTC)
cron.schedule('0 7 * * *', async () => {
  console.log('[BillingCron] Running daily billing job...');

  await chargeRenewals();
  await suspendGracePeriodExpired();
  await autoUpgradeTiers();
  await sendRenewalNotices();

  console.log('[BillingCron] Done.');
});

async function chargeRenewals() {
  const today = new Date();
  const dueSubscriptions = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      currentPeriodEnd: { lte: today },
      paystackAuthCode: { not: null },
    },
    include: { school: { select: { email: true, name: true } } },
  });

  for (const sub of dueSubscriptions) {
    try {
      const email = sub.school.email ?? '';
      const chargeRes = await axios.post(
        'https://api.paystack.co/transaction/charge_authorization',
        {
          email,
          amount: sub.monthlyAmountKobo,
          authorization_code: sub.paystackAuthCode,
          metadata: { schoolId: sub.schoolId, type: 'subscription_renewal' },
        },
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
      );

      if (chargeRes.data.data.status === 'success') {
        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        await prisma.subscription.update({
          where: { schoolId: sub.schoolId },
          data: {
            status: SubscriptionStatus.ACTIVE,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          },
        });
        await redis.del(`sub:${sub.schoolId}`);
        console.log(`[BillingCron] Renewed subscription for ${sub.school.name}`);
      } else {
        // Mark as past due
        await prisma.subscription.update({
          where: { schoolId: sub.schoolId },
          data: { status: SubscriptionStatus.PAST_DUE },
        });
        await redis.del(`sub:${sub.schoolId}`);

        if (email) {
          await sendEmail(
            email,
            'SchoolFlow — Subscription Payment Failed',
            `<p>We were unable to charge your SchoolFlow subscription of <strong>${formatNaira(sub.monthlyAmountKobo / 100)}</strong>.
             Please update your payment method within 7 days to avoid service interruption.</p>
             <a href="${process.env.APP_URL}/billing">Update Payment</a>`
          ).catch(console.error);
        }
      }
    } catch (e) {
      console.error(`[BillingCron] Charge failed for school ${sub.schoolId}:`, e);
    }
  }
}

async function suspendGracePeriodExpired() {
  const graceCutoff = new Date();
  graceCutoff.setDate(graceCutoff.getDate() - 7);

  const expired = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.PAST_DUE,
      currentPeriodEnd: { lte: graceCutoff },
    },
  });

  for (const sub of expired) {
    await prisma.subscription.update({
      where: { schoolId: sub.schoolId },
      data: { status: SubscriptionStatus.CANCELLED },
    });
    await redis.del(`sub:${sub.schoolId}`);
    console.log(`[BillingCron] Suspended school ${sub.schoolId} after grace period`);
  }
}

async function autoUpgradeTiers() {
  const activeSubs = await prisma.subscription.findMany({
    where: { status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL] } },
  });

  for (const sub of activeSubs) {
    const count = await prisma.student.count({
      where: { schoolId: sub.schoolId, isActive: true },
    });

    const requiredTier = tierForStudentCount(count);
    if (requiredTier !== sub.tier) {
      const newConfig = TIERS[requiredTier];
      await prisma.subscription.update({
        where: { schoolId: sub.schoolId },
        data: {
          tier: requiredTier,
          studentLimit: newConfig.maxStudents,
          monthlyAmountKobo: newConfig.monthlyNaira * 100,
        },
      });
      await redis.del(`sub:${sub.schoolId}`);
      console.log(`[BillingCron] Auto-upgraded school ${sub.schoolId} to ${requiredTier}`);
    }
  }
}

async function sendRenewalNotices() {
  const threeDaysOut = new Date();
  threeDaysOut.setDate(threeDaysOut.getDate() + 3);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  const upcoming = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      currentPeriodEnd: { gte: tomorrow, lte: threeDaysOut },
    },
    include: { school: { select: { email: true, name: true } } },
  });

  for (const sub of upcoming) {
    if (!sub.school.email) continue;
    const tierConfig = TIERS[sub.tier];
    await sendEmail(
      sub.school.email,
      `SchoolFlow Subscription Renews in 3 Days`,
      `<p>Hi ${sub.school.name},</p>
       <p>Your SchoolFlow <strong>${tierConfig.label}</strong> subscription renews on
       <strong>${sub.currentPeriodEnd.toLocaleDateString('en-NG')}</strong> for
       <strong>${formatNaira(sub.monthlyAmountKobo / 100)}</strong>.</p>
       <p>No action is required if your payment method is up to date.</p>
       <a href="${process.env.APP_URL}/billing">Manage Billing</a>`
    ).catch(console.error);
  }
}
