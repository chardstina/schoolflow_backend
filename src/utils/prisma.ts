import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
  });

if (process.env.NODE_ENV !== 'production') global.__prisma = prisma;

// Handle Neon serverless cold-start disconnections gracefully
process.on('uncaughtException', async (err: any) => {
  // Neon drops connections after inactivity — reconnect silently
  if (err?.code === 'P1001' || err?.message?.includes("Can't reach database")) {
    console.warn('[Prisma] DB connection lost — will reconnect on next request');
    try { await prisma.$disconnect(); } catch {}
    return; // don't crash
  }
  console.error('[Uncaught]', err);
  process.exit(1);
});

process.on('unhandledRejection', async (reason: any) => {
  if (reason?.code === 'P1001' || reason?.message?.includes("Can't reach database")) {
    console.warn('[Prisma] DB connection lost — will reconnect on next request');
    try { await prisma.$disconnect(); } catch {}
    return;
  }
  console.error('[UnhandledRejection]', reason);
});
