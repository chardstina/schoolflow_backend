import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate, resolveTenant, requireRole } from '../middleware/auth';
import { Role, InvoiceStatus } from '@prisma/client';

const router = Router();
router.use(authenticate, resolveTenant);

// GET /parent/children — returns each child with current invoice + summary
router.get('/children', requireRole(Role.PARENT), async (req: Request, res: Response) => {
  const parentProfile = await prisma.parentProfile.findUnique({
    where: { userId: req.user!.userId },
    include: { children: { include: { class: true, school: true } } },
  });

  if (!parentProfile) return res.json([]);

  const currentTerm = await prisma.term.findFirst({
    where: { schoolId: req.schoolId!, isCurrent: true },
  });

  const children = await Promise.all(
    parentProfile.children.map(async (student) => {
      // Current invoice
      const currentInvoice = currentTerm
        ? await prisma.invoice.findFirst({
            where: { schoolId: req.schoolId!, studentId: student.id, termId: currentTerm.id },
            include: { term: true },
          })
        : null;

      // Latest results average
      const results = currentTerm
        ? await prisma.result.findMany({
            where: { schoolId: req.schoolId!, studentId: student.id, termId: currentTerm.id, status: 'PUBLISHED' },
            select: { totalScore: true },
          })
        : [];

      const average =
        results.length > 0
          ? results.reduce((s, r) => s + Number(r.totalScore ?? 0), 0) / results.length
          : null;

      // Attendance rate this term
      const [present, total] = currentTerm
        ? await Promise.all([
            prisma.attendance.count({
              where: { schoolId: req.schoolId!, studentId: student.id, termId: currentTerm.id, status: 'PRESENT' },
            }),
            prisma.attendance.count({
              where: { schoolId: req.schoolId!, studentId: student.id, termId: currentTerm.id },
            }),
          ])
        : [0, 0];

      return {
        ...student,
        currentInvoice,
        latestResults: average != null ? { average, term: currentTerm?.name } : null,
        attendanceRate: total > 0 ? (present / total) * 100 : null,
      };
    })
  );

  return res.json(children);
});

export default router;
