/**
 * Student Routes
 * GET  /students/:id           — full profile (grades, attendance, invoice, parent)
 * POST /students               — register a new student
 * PUT  /students/:id           — update student details
 * DELETE /students/:id         — soft-deactivate
 * GET  /students/:id/report-card/:termId — shortcut to report card
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { authenticate, resolveTenant, requireRole } from '../middleware/auth';
import { Role, Gender } from '@prisma/client';
import { generateInvoiceNumber } from '../utils/invoiceNumber';

const router = Router();
router.use(authenticate, resolveTenant);

// ── Full Student Profile ───────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  const student = await prisma.student.findFirst({
    where: { id: req.params.id, schoolId: req.schoolId! },
    include: {
      class: true,
      school: { select: { name: true } },
      parent: {
        include: {
          user: { select: { firstName: true, lastName: true, email: true, phone: true } },
        },
      },
    },
  });
  if (!student) return res.status(404).json({ error: 'Student not found' });

  // PARENT: verify this student is their child
  if (req.user?.role === Role.PARENT) {
    const profile = await prisma.parentProfile.findUnique({
      where: { userId: req.user.userId },
      include: { children: { select: { id: true } } },
    });
    const childIds = profile?.children.map(c => c.id) ?? [];
    if (!childIds.includes(student.id)) {
      return res.status(403).json({ error: 'Access denied to this student\'s profile' });
    }
  }

  // Current term
  const currentTerm = await prisma.term.findFirst({
    where: { schoolId: req.schoolId!, isCurrent: true },
    include: { session: true },
  });

  // All results (published or all depending on role)
  const results = await prisma.result.findMany({
    where: {
      schoolId: req.schoolId!,
      studentId: student.id,
      ...(currentTerm ? { termId: currentTerm.id } : {}),
    },
    include: { subject: true, term: { include: { session: true } } },
    orderBy: { subject: { name: 'asc' } },
  });

  // Attendance this term
  const [present, absent, late, excused] = await Promise.all([
    prisma.attendance.count({ where: { schoolId: req.schoolId!, studentId: student.id, status: 'PRESENT', ...(currentTerm ? { termId: currentTerm.id } : {}) } }),
    prisma.attendance.count({ where: { schoolId: req.schoolId!, studentId: student.id, status: 'ABSENT',  ...(currentTerm ? { termId: currentTerm.id } : {}) } }),
    prisma.attendance.count({ where: { schoolId: req.schoolId!, studentId: student.id, status: 'LATE',    ...(currentTerm ? { termId: currentTerm.id } : {}) } }),
    prisma.attendance.count({ where: { schoolId: req.schoolId!, studentId: student.id, status: 'EXCUSED', ...(currentTerm ? { termId: currentTerm.id } : {}) } }),
  ]);

  // Fee invoice this term
  const invoice = currentTerm
    ? await prisma.invoice.findFirst({
        where: { schoolId: req.schoolId!, studentId: student.id, termId: currentTerm.id },
        include: { items: true },
      })
    : null;

  // Calculate age
  const age = student.dob
    ? Math.floor((Date.now() - student.dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25))
    : null;

  // Class position this term — compare this student's average against classmates
  let position: number | null = null;
  if (currentTerm && results.length > 0) {
    const myAvg = results.reduce((s, r) => s + Number(r.totalScore ?? 0), 0) / results.length;

    // Get all classmates' results and compute their averages
    const classmateResults = await prisma.result.groupBy({
      by: ['studentId'],
      where: {
        schoolId: req.schoolId!,
        classId: student.classId,
        termId: currentTerm.id,
        status: { in: ['APPROVED', 'PUBLISHED'] },
        studentId: { not: student.id },
      },
      _avg: { totalScore: true },
    });

    const betterCount = classmateResults.filter(
      (r) => Number(r._avg.totalScore ?? 0) > myAvg
    ).length;

    position = betterCount + 1;
  }

  const totalScore = results.reduce((s, r) => s + Number(r.totalScore ?? 0), 0);
  const average = results.length > 0 ? totalScore / results.length : 0;

  return res.json({
    student: { ...student, age },
    currentTerm,
    results,
    average,
    position,
    attendance: { present, absent, late, excused, total: present + absent + late + excused },
    invoice,
  });
});

// ── Register Student ──────────────────────────────────────────
const registerSchema = z.object({
  firstName:       z.string().min(2, 'First name must be at least 2 characters'),
  lastName:        z.string().min(2, 'Last name must be at least 2 characters'),
  middleName:      z.string().optional(),
  dob:             z.string().optional(),
  gender:          z.enum(['MALE', 'FEMALE']),
  classId:         z.string().min(1, 'Class is required'),
  admissionNo:     z.string().optional(),
  parentFirstName: z.string().optional(),
  parentLastName:  z.string().optional(),
  parentEmail:     z.string().email('Invalid parent email').optional().or(z.literal('')),
  parentPhone:     z.string().optional(),
  parentPassword:  z.string().min(8, 'Password must be at least 8 characters').optional(),
});

router.post('/', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  try {
    const parse = registerSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: parse.error.flatten() });
    }

    const d = parse.data;

    // Validate class belongs to this school
    const cls = await prisma.class.findFirst({ where: { id: d.classId, schoolId: req.schoolId! } });
    if (!cls) return res.status(400).json({ error: 'Selected class not found in this school' });

    // Auto-generate admission number if not provided
    const year = new Date().getFullYear();
    let admissionNo = d.admissionNo?.trim() || null;
    if (!admissionNo) {
      const count = await prisma.student.count({ where: { schoolId: req.schoolId! } });
      const prefix = cls.level.replace(/\D/g, '') || 'SF';
      admissionNo = `GFA/${year}/${String(count + 1).padStart(3, '0')}`;
    }

    // Check admission number uniqueness
    const existing = await prisma.student.findFirst({
      where: { schoolId: req.schoolId!, admissionNo },
    });
    if (existing) {
      return res.status(409).json({ error: `Admission number ${admissionNo} is already taken. Please enter a different one.` });
    }

    // Create or find parent account
    let parentProfileId: string | undefined;
    if (d.parentEmail && d.parentEmail.trim()) {
      try {
        const parentUser = await prisma.user.upsert({
          where: { email: d.parentEmail },
          update: { phone: d.parentPhone ?? undefined },
          create: {
            schoolId: req.schoolId!,
            email: d.parentEmail,
            passwordHash: await bcrypt.hash(d.parentPassword || 'Parent1234!', 12),
            firstName: d.parentFirstName || 'Parent',
            lastName:  d.parentLastName  || 'User',
            phone:     d.parentPhone     || null,
            role: Role.PARENT,
          },
        });
        const profile = await prisma.parentProfile.upsert({
          where: { userId: parentUser.id }, update: {}, create: { userId: parentUser.id },
        });
        parentProfileId = profile.id;
      } catch (parentErr: any) {
        console.error('[Register] Parent creation error:', parentErr);
        return res.status(400).json({ error: `Parent account error: ${parentErr.message}` });
      }
    }

    // Parse date of birth safely
    let dob: Date | null = null;
    if (d.dob && d.dob.trim()) {
      const parsed = new Date(d.dob);
      if (!isNaN(parsed.getTime())) dob = parsed;
    }

    // Create the student
    const student = await prisma.student.create({
      data: {
        schoolId:   req.schoolId!,
        admissionNo,
        firstName:  d.firstName.trim(),
        lastName:   d.lastName.trim(),
        middleName: d.middleName?.trim() || null,
        dob,
        gender:     d.gender,
        classId:    d.classId,
        parentId:   parentProfileId ?? null,
        enrolledAt: new Date(),
      },
      include: { class: true },
    });

    // Auto-generate fee invoice for current term
    const currentTerm = await prisma.term.findFirst({
      where: { schoolId: req.schoolId!, isCurrent: true },
    });
    if (currentTerm) {
      const structures = await prisma.feeStructure.findMany({
        where: {
          schoolId: req.schoolId!, termId: currentTerm.id, isCompulsory: true,
          OR: [{ classId: student.classId }, { classId: null }],
        },
      });
      if (structures.length > 0) {
        const invoiceNo = await generateInvoiceNumber(req.schoolId!);
        const totalKobo = structures.reduce((s, f) => s + f.amountKobo, 0);
        const dueDate = new Date(); dueDate.setDate(dueDate.getDate() + 21);
        await prisma.invoice.create({
          data: {
            schoolId: req.schoolId!, studentId: student.id, termId: currentTerm.id,
            invoiceNo, totalKobo, paidKobo: 0, balanceKobo: totalKobo,
            status: 'ISSUED', dueDate,
            items: {
              create: structures.map(s => ({
                feeStructureId: s.id, description: s.description, amountKobo: s.amountKobo,
              })),
            },
          },
        });
      }
    }

    return res.status(201).json({
      student,
      message: `${student.firstName} ${student.lastName} registered successfully. Admission No: ${admissionNo}`,
      ...(d.parentEmail ? { parentPassword: 'Parent1234!' } : {}),
    });

  } catch (err: any) {
    console.error('[Register student]', err);
    // Prisma unique constraint
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A student with that admission number already exists.' });
    }
    return res.status(500).json({ error: err.message ?? 'Failed to register student' });
  }
});

// ── Update Student ─────────────────────────────────────────────
router.put('/:id', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const { firstName, lastName, middleName, dob, gender, classId, isActive } = req.body;
  const updated = await prisma.student.updateMany({
    where: { id: req.params.id, schoolId: req.schoolId! },
    data: {
      ...(firstName  ? { firstName  } : {}),
      ...(lastName   ? { lastName   } : {}),
      ...(middleName !== undefined ? { middleName } : {}),
      ...(dob        ? { dob: new Date(dob) } : {}),
      ...(gender     ? { gender } : {}),
      ...(classId    ? { classId } : {}),
      ...(isActive   !== undefined ? { isActive } : {}),
    },
  });
  return res.json({ updated: updated.count });
});

// ── Soft delete student ────────────────────────────────────────
router.delete('/:id', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  await prisma.student.updateMany({
    where: { id: req.params.id, schoolId: req.schoolId! },
    data: { isActive: false },
  });
  return res.json({ message: 'Student deactivated' });
});

export default router;
