/**
 * Results Routes
 * POST /results/scores/bulk    — teacher bulk-enters scores
 * PUT  /results/:id            — update a single score
 * POST /results/submit         — teacher submits for approval
 * POST /results/approve        — admin approves a class/term batch
 * POST /results/publish        — admin publishes to parents
 * GET  /results                — list results (filtered)
 * GET  /results/report-card/:studentId/:termId — get full report card data
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { authenticate, resolveTenant, requireRole, requireActiveSubscription } from '../middleware/auth';
import { Role, ResultStatus } from '@prisma/client';
import { auditLog } from '../utils/audit';
import { notifyResultsPublished } from '../services/notifications';
import { generateReportCardPdf } from '../services/reportCard';
import { computeGrade } from '../utils/grading';

const router = Router();
router.use(authenticate, resolveTenant, requireActiveSubscription);

// ── Score Entry (Teacher) ─────────────────────────────────────

const bulkScoreSchema = z.object({
  classId: z.string(),
  subjectId: z.string(),
  termId: z.string(),
  scores: z.array(
    z.object({
      studentId: z.string(),
      caScore1: z.number().min(0).max(20).optional(),
      caScore2: z.number().min(0).max(20).optional(),
      examScore: z.number().min(0).max(60).optional(),
    })
  ),
});

router.post(
  '/scores/bulk',
  requireRole(Role.TEACHER, Role.SCHOOL_ADMIN),
  async (req: Request, res: Response) => {
    const parse = bulkScoreSchema.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });

    const { classId, subjectId, termId, scores } = parse.data;

    const upserted = await Promise.all(
      scores.map(({ studentId, caScore1, caScore2, examScore }) => {
        const total = (caScore1 ?? 0) + (caScore2 ?? 0) + (examScore ?? 0);
        const { grade, remark } = computeGrade(total);

        return prisma.result.upsert({
          where: {
            schoolId_studentId_subjectId_termId: {
              schoolId: req.schoolId!,
              studentId,
              subjectId,
              termId,
            },
          },
          create: {
            schoolId: req.schoolId!,
            studentId,
            classId,
            subjectId,
            termId,
            caScore1,
            caScore2,
            examScore,
            totalScore: total,
            grade,
            remark,
            status: ResultStatus.DRAFT,
          },
          update: {
            caScore1,
            caScore2,
            examScore,
            totalScore: total,
            grade,
            remark,
            status: ResultStatus.DRAFT,
          },
        });
      })
    );

    return res.json({ updated: upserted.length });
  }
);

// ── Submit for approval ────────────────────────────────────────

router.post(
  '/submit',
  requireRole(Role.TEACHER, Role.SCHOOL_ADMIN),
  async (req: Request, res: Response) => {
    const { classId, subjectId, termId } = req.body;

    // If subjectId omitted (HOD submitting whole class), submit all subjects
    const updated = await prisma.result.updateMany({
      where: {
        schoolId: req.schoolId!,
        classId,
        termId,
        ...(subjectId ? { subjectId } : {}),
        status: ResultStatus.DRAFT,
      },
      data: { status: ResultStatus.SUBMITTED, submittedAt: new Date() },
    });

    return res.json({ submitted: updated.count });
  }
);

// ── Admin approve ──────────────────────────────────────────────

router.post(
  '/approve',
  requireRole(Role.SCHOOL_ADMIN),
  async (req: Request, res: Response) => {
    const { classId, termId, subjectId } = req.body;

    const updated = await prisma.result.updateMany({
      where: {
        schoolId: req.schoolId!,
        classId,
        termId,
        ...(subjectId ? { subjectId } : {}),
        status: ResultStatus.SUBMITTED,
      },
      data: {
        status: ResultStatus.APPROVED,
        approvedAt: new Date(),
        approvedBy: req.user!.userId,
      },
    });

    await auditLog({
      schoolId: req.schoolId!,
      userId: req.user!.userId,
      action: 'RESULTS_APPROVED',
      entityType: 'Result',
      entityId: `${classId}:${termId}`,
      metadata: { count: updated.count },
    });

    return res.json({ approved: updated.count });
  }
);

// ── Publish to parents ─────────────────────────────────────────

router.post(
  '/publish',
  requireRole(Role.SCHOOL_ADMIN),
  async (req: Request, res: Response) => {
    const { classId, termId } = req.body;

    const updated = await prisma.result.updateMany({
      where: {
        schoolId: req.schoolId!,
        classId,
        termId,
        status: ResultStatus.APPROVED,
      },
      data: { status: ResultStatus.PUBLISHED, publishedAt: new Date() },
    });

    // Notify parents
    const students = await prisma.student.findMany({
      where: { schoolId: req.schoolId!, classId, isActive: true },
      include: {
        parent: { include: { user: true } },
        school: { select: { name: true } },
      },
    });

    const term = await prisma.term.findUnique({ where: { id: termId } });

    await Promise.allSettled(
      students.map((s) =>
        notifyResultsPublished(
          s.parent?.user.phone ?? null,
          s.parent?.user.email ?? null,
          s.parent?.user.firstName ?? 'Parent',
          `${s.firstName} ${s.lastName}`,
          s.school.name,
          term?.name ?? 'This Term'
        )
      )
    );

    return res.json({ published: updated.count });
  }
);

// ── Get results list ───────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const { classId, subjectId, termId, studentId, status } = req.query;

  // PARENT: can only see their own children's results (and only published ones)
  let allowedStudentIds: string[] | null = null;
  if (req.user?.role === Role.PARENT) {
    const profile = await prisma.parentProfile.findUnique({
      where: { userId: req.user.userId },
      include: { children: { select: { id: true } } },
    });
    allowedStudentIds = profile?.children.map(c => c.id) ?? [];
    if (studentId && !allowedStudentIds.includes(String(studentId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  const results = await prisma.result.findMany({
    where: {
      schoolId: req.schoolId!,
      ...(allowedStudentIds !== null
        ? {
            studentId: studentId ? String(studentId) : { in: allowedStudentIds },
            status: ResultStatus.PUBLISHED, // parents only see published
          }
        : {
            ...(studentId ? { studentId: String(studentId) } : {}),
            ...(status ? { status: status as ResultStatus } : {}),
          }),
      ...(classId ? { classId: String(classId) } : {}),
      ...(subjectId ? { subjectId: String(subjectId) } : {}),
      ...(termId ? { termId: String(termId) } : {}),
    },
    include: {
      student: { select: { firstName: true, lastName: true, admissionNo: true } },
      subject: true,
    },
    orderBy: [{ student: { lastName: 'asc' } }],
  });
  return res.json(results);
});

// ── Report Card data endpoint ─────────────────────────────────

router.get('/report-card/:studentId/:termId', async (req: Request, res: Response) => {
  const { studentId, termId } = req.params;
  const { format } = req.query; // ?format=pdf

  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId: req.schoolId! },
    include: { class: true, school: true },
  });
  if (!student) return res.status(404).json({ error: 'Student not found' });

  // Parent: verify the student belongs to them
  if (req.user!.role === Role.PARENT) {
    const profile = await prisma.parentProfile.findUnique({
      where: { userId: req.user!.userId },
      include: { children: { select: { id: true } } },
    });
    const childIds = profile?.children.map(c => c.id) ?? [];
    if (!childIds.includes(student.id)) {
      return res.status(403).json({ error: 'Access denied to this student\'s report card' });
    }
  }

  // Only published results visible to parents; admin/teacher can see any
  const statusFilter =
    req.user!.role === Role.PARENT
      ? { status: ResultStatus.PUBLISHED }
      : {};

  const results = await prisma.result.findMany({
    where: { schoolId: req.schoolId!, studentId, termId, ...statusFilter },
    include: { subject: true },
    orderBy: { subject: { name: 'asc' } },
  });

  const term = await prisma.term.findUnique({
    where: { id: termId },
    include: { session: true },
  });

  // Calculate class positions per subject
  for (const r of results) {
    const betterScores = await prisma.result.count({
      where: {
        schoolId: req.schoolId!,
        classId: student.classId,
        subjectId: r.subjectId,
        termId,
        totalScore: { gt: r.totalScore ?? 0 },
      },
    });
    r.position = betterScores + 1;
  }

  const attendanceSummary = await prisma.attendance.groupBy({
    by: ['status'],
    where: { schoolId: req.schoolId!, studentId, termId },
    _count: true,
  });

  const reportCardData = {
    student,
    term,
    results,
    attendanceSummary,
    totalScore: results.reduce((s, r) => s + Number(r.totalScore ?? 0), 0),
    average:
      results.length > 0
        ? results.reduce((s, r) => s + Number(r.totalScore ?? 0), 0) / results.length
        : 0,
  };

  if (format === 'pdf') {
    const pdfBuffer = await generateReportCardPdf(reportCardData);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="report-card-${student.admissionNo}-${term?.name}.pdf"`
    );
    return res.send(pdfBuffer);
  }

  return res.json(reportCardData);
});

export default router;
