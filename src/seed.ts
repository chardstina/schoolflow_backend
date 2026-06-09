/**
 * SchoolFlow — Full Demo Seed
 * Run: npx prisma db seed
 *
 * Creates Greenfield Academy with:
 *  - 12 classes: JSS1A/B → JSS3A/B, SS1A/B → SS3A/B
 *  - 12 core subjects
 *  - 5 demo teachers, 1 accountant, 1 admin
 *  - 1 parent with 1 student
 *  - Fee structures per level
 *  - Current academic session & term
 */

import 'dotenv/config';
import {
  PrismaClient, Role, Gender, FeeCategory,
  SubscriptionTier, SubscriptionStatus,
} from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const CLASSES = [
  { name: 'JSS 1A', level: 'JSS1' }, { name: 'JSS 1B', level: 'JSS1' },
  { name: 'JSS 2A', level: 'JSS2' }, { name: 'JSS 2B', level: 'JSS2' },
  { name: 'JSS 3A', level: 'JSS3' }, { name: 'JSS 3B', level: 'JSS3' },
  { name: 'SS 1A',  level: 'SS1'  }, { name: 'SS 1B',  level: 'SS1'  },
  { name: 'SS 2A',  level: 'SS2'  }, { name: 'SS 2B',  level: 'SS2'  },
  { name: 'SS 3A',  level: 'SS3'  }, { name: 'SS 3B',  level: 'SS3'  },
];

const SUBJECTS = [
  { name: 'Mathematics',          code: 'MTH' },
  { name: 'English Language',     code: 'ENG' },
  { name: 'Basic Science',        code: 'BSC' },
  { name: 'Social Studies',       code: 'SST' },
  { name: 'Civic Education',      code: 'CIV' },
  { name: 'Agricultural Science', code: 'AGR' },
  { name: 'Computer Science',     code: 'CMP' },
  { name: 'Physics',              code: 'PHY' },
  { name: 'Chemistry',            code: 'CHM' },
  { name: 'Biology',              code: 'BIO' },
  { name: 'Literature in English',code: 'LIT' },
  { name: 'Economics',            code: 'ECO' },
];

// Fee amounts per level (kobo)
const FEE_STRUCTURE: Record<string, { tuition: number; dev: number; exam: number }> = {
  JSS1: { tuition: 75_000_00, dev: 8_000_00, exam: 4_000_00 },
  JSS2: { tuition: 75_000_00, dev: 8_000_00, exam: 4_000_00 },
  JSS3: { tuition: 80_000_00, dev: 8_000_00, exam: 5_000_00 },
  SS1:  { tuition: 90_000_00, dev: 10_000_00, exam: 6_000_00 },
  SS2:  { tuition: 90_000_00, dev: 10_000_00, exam: 6_000_00 },
  SS3:  { tuition: 95_000_00, dev: 10_000_00, exam: 8_000_00 },
};

async function main() {
  console.log('🌱 Seeding SchoolFlow — Full Setup…\n');

  const hash = (pw: string) => bcrypt.hash(pw, 12);

  // ── School ──────────────────────────────────────────────────
  const school = await prisma.school.upsert({
    where: { slug: 'greenfield' },
    update: {},
    create: {
      name: 'Greenfield Academy',
      slug: 'greenfield',
      address: '14 Adeola Odeku Street, Victoria Island, Lagos',
      phone: '08012345678',
      email: 'info@greenfield.edu.ng',
      platformCutPct: 2.5,
    },
  });
  console.log('✅ School:', school.name);

  // ── Subscription ────────────────────────────────────────────
  const now = new Date();
  const trialEnd = new Date(now); trialEnd.setDate(trialEnd.getDate() + 30);
  await prisma.subscription.upsert({
    where: { schoolId: school.id }, update: {},
    create: {
      schoolId: school.id, tier: SubscriptionTier.GROWTH,
      status: SubscriptionStatus.TRIAL,
      currentPeriodStart: now, currentPeriodEnd: trialEnd,
      trialEndsAt: trialEnd, monthlyAmountKobo: 25_000 * 100, studentLimit: 500,
    },
  });

  // ── Session & Term ──────────────────────────────────────────
  const session = await prisma.academicSession.upsert({
    where: { id: 'seed-session-1' }, update: {},
    create: { id: 'seed-session-1', schoolId: school.id, name: '2024/2025', isCurrent: true },
  });
  const term = await prisma.term.upsert({
    where: { id: 'seed-term-1' }, update: {},
    create: {
      id: 'seed-term-1', schoolId: school.id, sessionId: session.id,
      name: 'First Term', startDate: new Date('2024-09-09'),
      endDate: new Date('2024-12-13'), isCurrent: true,
    },
  });
  console.log('✅ Session/Term:', session.name, '/', term.name);

  // ── Classes ─────────────────────────────────────────────────
  const classMap: Record<string, any> = {};
  for (const c of CLASSES) {
    const cls = await prisma.class.upsert({
      where: { schoolId_name: { schoolId: school.id, name: c.name } },
      update: {}, create: { schoolId: school.id, name: c.name, level: c.level, capacity: 40 },
    });
    classMap[c.name] = cls;
  }
  console.log('✅ Classes:', Object.keys(classMap).join(', '));

  // ── Subjects ────────────────────────────────────────────────
  const subjectMap: Record<string, any> = {};
  for (const s of SUBJECTS) {
    const subj = await prisma.subject.upsert({
      where: { schoolId_code: { schoolId: school.id, code: s.code } },
      update: {}, create: { schoolId: school.id, name: s.name, code: s.code },
    });
    subjectMap[s.code] = subj;
  }
  console.log('✅ Subjects:', SUBJECTS.map(s => s.name).join(', '));

  // ── Fee Structures ──────────────────────────────────────────
  for (const c of CLASSES) {
    const cls = classMap[c.name];
    const fees = FEE_STRUCTURE[c.level];
    const feeItems = [
      { category: FeeCategory.TUITION,     description: 'School Fees (Tuition)', amountKobo: fees.tuition },
      { category: FeeCategory.DEVELOPMENT, description: 'Development Levy',      amountKobo: fees.dev    },
      { category: FeeCategory.EXAM,        description: 'Examination Fee',        amountKobo: fees.exam   },
    ];
    for (const fee of feeItems) {
      await prisma.feeStructure.create({ data: { schoolId: school.id, termId: term.id, classId: cls.id, isCompulsory: true, ...fee } })
        .catch(() => {}); // ignore duplicate
    }
  }
  console.log('✅ Fee structures created for all 12 classes');

  // ── Admin User ──────────────────────────────────────────────
  await prisma.user.upsert({
    where: { email: 'admin@greenfield.edu.ng' }, update: {},
    create: {
      schoolId: school.id, email: 'admin@greenfield.edu.ng',
      passwordHash: await hash('Admin1234!'),
      firstName: 'Amaka', lastName: 'Okonkwo',
      role: Role.SCHOOL_ADMIN, phone: '08011111111',
    },
  });

  // ── Accountant ──────────────────────────────────────────────
  await prisma.user.upsert({
    where: { email: 'accountant@greenfield.edu.ng' }, update: {},
    create: {
      schoolId: school.id, email: 'accountant@greenfield.edu.ng',
      passwordHash: await hash('Account1234!'),
      firstName: 'Kemi', lastName: 'Adeleke',
      role: Role.ACCOUNTANT, phone: '08044444444',
    },
  });

  // ── Teachers ────────────────────────────────────────────────
  const teachers = [
    { email: 'emeka@greenfield.edu.ng',   first: 'Emeka',  last: 'Nwachukwu', codes: ['MTH','PHY'],        classes: ['JSS 1A','SS 1A','SS 2A'] },
    { email: 'ngozi@greenfield.edu.ng',   first: 'Ngozi',  last: 'Eze',       codes: ['ENG','LIT'],        classes: ['JSS 1B','JSS 2A','SS 1B'] },
    { email: 'biodun@greenfield.edu.ng',  first: 'Biodun', last: 'Adeyemi',   codes: ['CHM','BIO'],        classes: ['SS 2A','SS 2B','SS 3A'] },
    { email: 'chidi@greenfield.edu.ng',   first: 'Chidi',  last: 'Okafor',    codes: ['BSC','AGR'],        classes: ['JSS 2A','JSS 2B','JSS 3A'] },
    { email: 'fatima@greenfield.edu.ng',  first: 'Fatima', last: 'Bello',     codes: ['SST','CIV','ECO'],  classes: ['JSS 3A','JSS 3B','SS 3B'] },
  ];

  for (const t of teachers) {
    const user = await prisma.user.upsert({
      where: { email: t.email }, update: {},
      create: {
        schoolId: school.id, email: t.email,
        passwordHash: await hash('Teacher1234!'),
        firstName: t.first, lastName: t.last,
        role: Role.TEACHER, phone: `080${Math.floor(10000000 + Math.random() * 89999999)}`,
      },
    });
    const classIds = t.classes.map(n => classMap[n]?.id).filter(Boolean);
    const subjectIds = t.codes.map(c => subjectMap[c]?.id).filter(Boolean);
    await prisma.teacherProfile.upsert({
      where: { userId: user.id }, update: { classIds, subjectIds },
      create: { userId: user.id, staffId: `TCH-${t.first.slice(0,3).toUpperCase()}`, classIds, subjectIds },
    });
    // Link subjects to classes
    for (const classId of classIds) {
      for (const subjectId of subjectIds) {
        await prisma.classSubject.upsert({
          where: { classId_subjectId: { classId, subjectId } },
          update: { teacherId: user.id },
          create: { classId, subjectId, teacherId: user.id },
        }).catch(() => {});
      }
    }
  }
  console.log('✅ Teachers: Emeka, Ngozi, Biodun, Chidi, Fatima');

  // ── Parent & Student ────────────────────────────────────────
  const parentUser = await prisma.user.upsert({
    where: { email: 'parent@greenfield.edu.ng' }, update: {},
    create: {
      schoolId: school.id, email: 'parent@greenfield.edu.ng',
      passwordHash: await hash('Parent1234!'),
      firstName: 'Ngozi', lastName: 'Okeke',
      role: Role.PARENT, phone: '08033333333',
    },
  });
  const parentProfile = await prisma.parentProfile.upsert({
    where: { userId: parentUser.id }, update: {}, create: { userId: parentUser.id },
  });
  await prisma.student.upsert({
    where: { schoolId_admissionNo: { schoolId: school.id, admissionNo: 'GFA/2024/001' } },
    update: {},
    create: {
      schoolId: school.id, admissionNo: 'GFA/2024/001',
      firstName: 'Chidi', lastName: 'Okeke',
      gender: Gender.MALE, classId: classMap['JSS 1A'].id,
      parentId: parentProfile.id, enrolledAt: new Date(),
    },
  });
  console.log('✅ Parent + Student: Chidi Okeke → JSS 1A');

  console.log('\n─────────────────────────────────────────────────────');
  console.log('🎉 Full seed complete!\n');
  console.log('  ADMIN       → admin@greenfield.edu.ng        / Admin1234!');
  console.log('  ACCOUNTANT  → accountant@greenfield.edu.ng   / Account1234!');
  console.log('  TEACHER(s)  → emeka@greenfield.edu.ng        / Teacher1234!');
  console.log('               ngozi@greenfield.edu.ng         / Teacher1234!');
  console.log('  PARENT      → parent@greenfield.edu.ng       / Parent1234!');
  console.log('─────────────────────────────────────────────────────\n');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
