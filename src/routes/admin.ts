import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { authenticate, resolveTenant, requireRole } from '../middleware/auth';
import { Role, InvoiceStatus } from '@prisma/client';

const router = Router();
router.use(authenticate, resolveTenant);

// GET /admin/dashboard?termId=xxx
router.get('/dashboard', requireRole(Role.SCHOOL_ADMIN, Role.ACCOUNTANT, Role.SUPER_ADMIN), async (req: Request, res: Response) => {
  const schoolId = req.schoolId!;
  const { termId } = req.query;

  // Use specified term or fall back to current
  const currentTerm = termId
    ? await prisma.term.findFirst({ where: { id: String(termId), schoolId }, include: { session: true } })
    : await prisma.term.findFirst({ where: { schoolId, isCurrent: true }, include: { session: true } });

  const [
    totalStudents,
    activeClasses,
    totalStaff,
    termInvoices,
    recentPayments,
    pendingProofs,
  ] = await Promise.all([
    prisma.student.count({ where: { schoolId, isActive: true } }),
    prisma.class.count({ where: { schoolId } }),
    prisma.user.count({
      where: { schoolId, role: { in: [Role.TEACHER, Role.ACCOUNTANT, Role.SCHOOL_ADMIN] } },
    }),
    currentTerm
      ? prisma.invoice.findMany({
          where: { schoolId, termId: currentTerm.id },
          select: { totalKobo: true, paidKobo: true, balanceKobo: true, status: true, student: { select: { classId: true } } },
        })
      : [],
    prisma.payment.findMany({
      where: { schoolId },
      orderBy: { paidAt: 'desc' },
      take: 10,
      include: {
        invoice: {
          include: {
            student: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.paymentProof.count({ where: { schoolId, status: 'PENDING' } }),
  ]);

  let termRevenue = 0;
  let termTotal = 0;
  let outstandingFees = 0;
  for (const inv of termInvoices as any[]) {
    termRevenue += inv.paidKobo;
    termTotal += inv.totalKobo;
    outstandingFees += inv.balanceKobo;
  }
  const collectionRate = termTotal > 0 ? (termRevenue / termTotal) * 100 : 0;
  const overdueInvoices = termInvoices.filter((i: any) =>
    [InvoiceStatus.ISSUED, InvoiceStatus.PARTIAL, InvoiceStatus.OVERDUE].includes(i.status)
  ).length;

  // Fee by class
  const classes = await prisma.class.findMany({ where: { schoolId }, select: { id: true, name: true } });
  const feeByClass = await Promise.all(
    classes.map(async (cls) => {
      const classInvoices = currentTerm
        ? await prisma.invoice.findMany({
            where: { schoolId, termId: currentTerm.id, student: { classId: cls.id } },
            select: { totalKobo: true, paidKobo: true },
          })
        : [];
      return {
        className: cls.name,
        totalKobo: classInvoices.reduce((s, i) => s + i.totalKobo, 0),
        paidKobo: classInvoices.reduce((s, i) => s + i.paidKobo, 0),
      };
    })
  );

  return res.json({
    currentTerm,
    totalStudents,
    activeClasses,
    totalStaff,
    termRevenue,
    outstandingFees,
    collectionRate,
    overdueInvoices,
    pendingProofs,
    recentPayments: recentPayments.map((p) => ({
      id: p.id,
      studentName: `${p.invoice.student.firstName} ${p.invoice.student.lastName}`,
      amountKobo: p.amountKobo,
      paidAt: p.paidAt,
      channel: p.channel,
    })),
    feeByClass,
  });
});

// GET /admin/students
router.get('/students', requireRole(Role.SCHOOL_ADMIN, Role.ACCOUNTANT, Role.TEACHER), async (req: Request, res: Response) => {
  const { classId, search, active } = req.query;
  const students = await prisma.student.findMany({
    where: {
      schoolId: req.schoolId!,
      ...(active !== undefined ? { isActive: active === 'true' } : {}),
      ...(classId ? { classId: String(classId) } : {}),
      ...(search ? {
        OR: [
          { firstName: { contains: String(search), mode: 'insensitive' } },
          { lastName: { contains: String(search), mode: 'insensitive' } },
          { admissionNo: { contains: String(search), mode: 'insensitive' } },
        ],
      } : {}),
    },
    include: { class: true, parent: { include: { user: { select: { firstName: true, lastName: true, email: true, phone: true } } } } },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  return res.json(students);
});

// GET /classes
router.get('/classes', async (req: Request, res: Response) => {
  const classes = await prisma.class.findMany({
    where: { schoolId: req.schoolId! },
    orderBy: { name: 'asc' },
  });
  return res.json(classes);
});

// GET /terms
router.get('/terms', async (req: Request, res: Response) => {
  const { current } = req.query;
  const terms = await prisma.term.findMany({
    where: {
      schoolId: req.schoolId!,
      ...(current === 'true' ? { isCurrent: true } : {}),
    },
    include: { session: true },
    orderBy: { startDate: 'desc' },
  });
  return res.json(terms);
});

// GET /subjects
router.get('/subjects', async (req: Request, res: Response) => {
  const { classId } = req.query;
  if (classId) {
    const classSubjects = await prisma.classSubject.findMany({
      where: { classId: String(classId) },
      include: { subject: true },
    });
    return res.json(classSubjects.map((cs) => cs.subject));
  }
  const subjects = await prisma.subject.findMany({
    where: { schoolId: req.schoolId! },
    orderBy: { name: 'asc' },
  });
  return res.json(subjects);
});

// GET /students (flat, for teacher score entry)
router.get('/students-list', async (req: Request, res: Response) => {
  const { classId, active } = req.query;
  const students = await prisma.student.findMany({
    where: {
      schoolId: req.schoolId!,
      ...(active !== undefined ? { isActive: active === 'true' } : {}),
      ...(classId ? { classId: String(classId) } : {}),
    },
    select: { id: true, firstName: true, lastName: true, admissionNo: true, classId: true },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  return res.json(students);
});

// GET /attendance
router.get('/attendance', async (req: Request, res: Response) => {
  const { classId, date, studentId, termId } = req.query;
  const attendance = await prisma.attendance.findMany({
    where: {
      schoolId: req.schoolId!,
      ...(classId ? { classId: String(classId) } : {}),
      ...(studentId ? { studentId: String(studentId) } : {}),
      ...(termId ? { termId: String(termId) } : {}),
      ...(date ? { date: new Date(String(date)) } : {}),
    },
    include: { student: { select: { firstName: true, lastName: true, admissionNo: true } } },
  });
  return res.json(attendance);
});

// POST /attendance/bulk
router.post('/attendance/bulk', requireRole(Role.TEACHER, Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const { classId, termId, date, records } = req.body;
  if (!classId || !termId || !date || !Array.isArray(records)) {
    return res.status(400).json({ error: 'classId, termId, date and records required' });
  }

  const attendanceDate = new Date(date);

  await Promise.all(
    records.map((r: { studentId: string; status: string }) =>
      prisma.attendance.upsert({
        where: {
          schoolId_studentId_date: {
            schoolId: req.schoolId!,
            studentId: r.studentId,
            date: attendanceDate,
          },
        },
        create: {
          schoolId: req.schoolId!,
          studentId: r.studentId,
          classId,
          termId,
          date: attendanceDate,
          status: r.status as any,
          markedBy: req.user!.userId,
        },
        update: {
          status: r.status as any,
          markedBy: req.user!.userId,
        },
      })
    )
  );

  return res.json({ saved: records.length });
});

// POST /admin/classes — create a class
router.post('/classes', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const { name, level, capacity } = req.body;
  if (!name || !level) return res.status(400).json({ error: 'name and level required' });
  const cls = await prisma.class.create({
    data: { schoolId: req.schoolId!, name, level, capacity: Number(capacity) || 40 },
  }).catch(() => null);
  if (!cls) return res.status(409).json({ error: 'Class already exists' });
  return res.status(201).json(cls);
});

// POST /admin/subjects — create a subject
router.post('/subjects', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const { name, code } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'name and code required' });
  const subj = await prisma.subject.create({
    data: { schoolId: req.schoolId!, name, code: code.toUpperCase() },
  }).catch(() => null);
  if (!subj) return res.status(409).json({ error: 'Subject code already exists' });
  return res.status(201).json(subj);
});

// GET /admin/staff — list all staff
router.get('/staff', requireRole(Role.SCHOOL_ADMIN, Role.ACCOUNTANT), async (req: Request, res: Response) => {
  const staff = await prisma.user.findMany({
    where: {
      schoolId: req.schoolId!,
      role: { in: [Role.TEACHER, Role.ACCOUNTANT, Role.SCHOOL_ADMIN] },
    },
    include: { teacherProfile: true },
    orderBy: [{ role: 'asc' }, { lastName: 'asc' }],
  });
  return res.json(staff);
});

// POST /admin/staff — add a new staff member
router.post('/staff', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const { firstName, lastName, email, phone, role, staffId, password } = req.body;
  if (!firstName || !lastName || !email || !role) {
    return res.status(400).json({ error: 'firstName, lastName, email and role required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const validRoles: Role[] = [Role.TEACHER, Role.ACCOUNTANT, Role.SCHOOL_ADMIN];
  if (!validRoles.includes(role as Role)) return res.status(400).json({ error: 'Invalid role' });

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      schoolId: req.schoolId!, email, passwordHash,
      firstName, lastName, phone: phone || null,
      role: role as Role, isActive: true,
    },
  }).catch(() => null);

  if (!user) return res.status(409).json({ error: 'Email already exists' });

  if (role === Role.TEACHER) {
    await prisma.teacherProfile.create({
      data: { userId: user.id, staffId: staffId || null, classIds: [], subjectIds: [] },
    });
  }

  return res.status(201).json({ ...user, passwordHash: undefined, defaultPassword: 'Welcome1234!' });
});

// DELETE /admin/staff/:id
router.delete('/staff/:id', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const user = await prisma.user.findFirst({
    where: { id: req.params.id, schoolId: req.schoolId! },
  });
  if (!user) return res.status(404).json({ error: 'Staff not found' });
  if (user.role === Role.SCHOOL_ADMIN) return res.status(400).json({ error: 'Cannot delete a school admin' });

  // Delete teacher profile first if exists
  await prisma.teacherProfile.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  return res.json({ message: 'Staff member removed' });
});

// PUT /admin/classes/:id/subjects — assign subjects to a class
router.put('/classes/:id/subjects', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const { subjectIds } = req.body; // string[]
  if (!Array.isArray(subjectIds)) return res.status(400).json({ error: 'subjectIds must be an array' });

  const classId = req.params.id;

  // Verify class belongs to this school
  const cls = await prisma.class.findFirst({ where: { id: classId, schoolId: req.schoolId! } });
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  // Delete existing class-subject links for this class
  await prisma.classSubject.deleteMany({ where: { classId } });

  // Re-create with new selection
  if (subjectIds.length > 0) {
    await prisma.classSubject.createMany({
      data: subjectIds.map((subjectId: string) => ({ classId, subjectId })),
      skipDuplicates: true,
    });
  }

  return res.json({ assigned: subjectIds.length });
});

// GET /admin/classes/:id/subjects — get subjects for a class
router.get('/classes/:id/subjects', async (req: Request, res: Response) => {
  const classSubjects = await prisma.classSubject.findMany({
    where: { classId: req.params.id },
    include: { subject: true },
    orderBy: { subject: { name: 'asc' } },
  });
  return res.json(classSubjects.map(cs => cs.subject));
});

// GET /admin/sessions — list all academic sessions
router.get('/sessions', async (req: Request, res: Response) => {
  const sessions = await prisma.academicSession.findMany({
    where: { schoolId: req.schoolId! },
    include: { terms: { orderBy: { startDate: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  return res.json(sessions);
});

// POST /admin/sessions — create a new academic session
router.post('/sessions', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const { name, isCurrent } = req.body;
  if (!name) return res.status(400).json({ error: 'Session name required (e.g. 2025/2026)' });

  // If setting as current, unset others first
  if (isCurrent) {
    await prisma.academicSession.updateMany({
      where: { schoolId: req.schoolId! },
      data: { isCurrent: false },
    });
  }

  const session = await prisma.academicSession.create({
    data: { schoolId: req.schoolId!, name, isCurrent: !!isCurrent },
  });
  return res.status(201).json(session);
});

// POST /admin/terms — create a term under a session
router.post('/terms', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const { sessionId, name, startDate, endDate, isCurrent } = req.body;
  if (!sessionId || !name || !startDate || !endDate) {
    return res.status(400).json({ error: 'sessionId, name, startDate and endDate required' });
  }

  // Validate session belongs to this school
  const session = await prisma.academicSession.findFirst({
    where: { id: sessionId, schoolId: req.schoolId! },
  });
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // If setting as current, unset other current terms for this school
  if (isCurrent) {
    await prisma.term.updateMany({
      where: { schoolId: req.schoolId! },
      data: { isCurrent: false },
    });
  }

  const term = await prisma.term.create({
    data: {
      schoolId: req.schoolId!,
      sessionId,
      name,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      isCurrent: !!isCurrent,
    },
    include: { session: true },
  });
  return res.status(201).json(term);
});

// PUT /admin/terms/:id/set-current — mark a term as current
router.put('/terms/:id/set-current', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  await prisma.term.updateMany({ where: { schoolId: req.schoolId! }, data: { isCurrent: false } });
  await prisma.academicSession.updateMany({ where: { schoolId: req.schoolId! }, data: { isCurrent: false } });

  const term = await prisma.term.findFirst({ where: { id: req.params.id, schoolId: req.schoolId! } });
  if (!term) return res.status(404).json({ error: 'Term not found' });

  await prisma.term.update({ where: { id: term.id }, data: { isCurrent: true } });
  await prisma.academicSession.update({ where: { id: term.sessionId }, data: { isCurrent: true } });

  return res.json({ message: 'Current term updated' });
});

// DELETE /admin/terms/:id
router.delete('/terms/:id', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const term = await prisma.term.findFirst({ where: { id: req.params.id, schoolId: req.schoolId! } });
  if (!term) return res.status(404).json({ error: 'Term not found' });
  if (term.isCurrent) return res.status(400).json({ error: 'Cannot delete the current term' });
  await prisma.term.delete({ where: { id: term.id } });
  return res.json({ message: 'Term deleted' });
});

// PUT /admin/classes/:id/hod — assign head teacher
router.put('/classes/:id/hod', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const { headTeacherId } = req.body;
  const cls = await prisma.class.updateMany({
    where: { id: req.params.id, schoolId: req.schoolId! },
    data: { headTeacherId: headTeacherId || null },
  });
  return res.json({ updated: cls.count });
});

// GET /admin/classes/:id/rankings — top students by average this term
router.get('/classes/:id/rankings', async (req: Request, res: Response) => {
  const classId = req.params.id;
  const termId = req.query.termId as string | undefined;

  const currentTerm = termId
    ? await prisma.term.findUnique({ where: { id: termId } })
    : await prisma.term.findFirst({ where: { schoolId: req.schoolId!, isCurrent: true } });

  if (!currentTerm) return res.status(404).json({ error: 'No current term found' });

  const students = await prisma.student.findMany({
    where: { schoolId: req.schoolId!, classId, isActive: true },
    select: { id: true, firstName: true, lastName: true, admissionNo: true },
  });

  const rankings = await Promise.all(
    students.map(async (s) => {
      const results = await prisma.result.findMany({
        where: { schoolId: req.schoolId!, studentId: s.id, classId, termId: currentTerm.id },
        select: { totalScore: true, grade: true, subject: { select: { name: true } } },
      });
      const total = results.reduce((sum, r) => sum + Number(r.totalScore ?? 0), 0);
      const average = results.length > 0 ? total / results.length : 0;
      return { ...s, average: parseFloat(average.toFixed(2)), totalScore: total, subjectCount: results.length, results };
    })
  );

  rankings.sort((a, b) => b.average - a.average);
  const ranked = rankings.map((s, i) => ({ ...s, position: i + 1 }));

  return res.json({
    class: await prisma.class.findUnique({ where: { id: classId }, select: { name: true, level: true, headTeacherId: true } }),
    term: currentTerm,
    rankings: ranked,
    top3: ranked.slice(0, 3),
  });
});

// GET /admin/teacher/my-classes — classes assigned to the logged-in teacher
router.get('/teacher/my-classes', requireRole(Role.TEACHER, Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const profile = await prisma.teacherProfile.findUnique({ where: { userId: req.user!.userId } });
  if (!profile) return res.json([]);
  const classes = await prisma.class.findMany({
    where: { id: { in: profile.classIds }, schoolId: req.schoolId! },
    orderBy: { name: 'asc' },
  });
  return res.json(classes);
});

// GET /admin/attendance/weekly?studentId=&termId=&classId=
// Returns attendance grouped by ISO week, Mon-Fri
router.get('/attendance/weekly', async (req: Request, res: Response) => {
  const { studentId, termId, classId } = req.query;

  const records = await prisma.attendance.findMany({
    where: {
      schoolId: req.schoolId!,
      ...(studentId ? { studentId: String(studentId) } : {}),
      ...(termId    ? { termId:    String(termId)    } : {}),
      ...(classId   ? { classId:   String(classId)   } : {}),
    },
    include: { student: { select: { firstName: true, lastName: true, admissionNo: true } } },
    orderBy: { date: 'asc' },
  });

  // Group by student → week
  const byStudent: Record<string, {
    student: any;
    weeks: Record<string, Record<string, string>>; // weekKey → dayKey → status
  }> = {};

  const getWeekKey = (d: Date) => {
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
  };

  const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  for (const r of records) {
    const sid = r.studentId;
    if (!byStudent[sid]) byStudent[sid] = { student: r.student, weeks: {} };
    const d = new Date(r.date);
    const weekKey = getWeekKey(d);
    const dayOfWeek = d.getDay(); // 0=Sun,1=Mon...
    const dayName = DAY_NAMES[dayOfWeek] ?? 'Other';
    if (!byStudent[sid].weeks[weekKey]) byStudent[sid].weeks[weekKey] = {};
    byStudent[sid].weeks[weekKey][dayName] = r.status;
  }

  // Compute weekly summary stats per student
  const result = Object.entries(byStudent).map(([sid, data]) => {
    const totalPresent = records.filter(r => r.studentId === sid && r.status === 'PRESENT').length;
    const totalDays    = records.filter(r => r.studentId === sid).length;
    return {
      studentId: sid,
      student: data.student,
      weeks: data.weeks,
      summary: { present: totalPresent, total: totalDays, rate: totalDays > 0 ? ((totalPresent / totalDays) * 100).toFixed(1) : '0' },
    };
  });

  return res.json(result);
});

// GET /admin/fee-breakdown?classId=&termId= — what a student in this class owes this term
router.get('/fee-breakdown', async (req: Request, res: Response) => {
  const { classId, termId } = req.query;
  const structures = await prisma.feeStructure.findMany({
    where: {
      schoolId: req.schoolId!,
      ...(termId ? { termId: String(termId) } : {}),
      ...(classId ? { OR: [{ classId: String(classId) }, { classId: null }] } : {}),
    },
    include: { term: true },
    orderBy: { category: 'asc' },
  });
  const total = structures.reduce((s, f) => s + f.amountKobo, 0);
  return res.json({ structures, totalKobo: total });
});

// GET /admin/payroll
router.get('/payroll', requireRole(Role.SCHOOL_ADMIN, Role.ACCOUNTANT), async (req: Request, res: Response) => {
  const { month, year } = req.query;
  const entries = await prisma.payrollEntry.findMany({
    where: {
      schoolId: req.schoolId!,
      ...(month ? { month: Number(month) } : {}),
      ...(year ? { year: Number(year) } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
  return res.json(entries);
});
