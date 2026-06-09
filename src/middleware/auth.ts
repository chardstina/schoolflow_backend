import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { Role } from '@prisma/client';

export interface AuthPayload {
  userId: string;
  schoolId: string | null;
  role: Role;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
      schoolId?: string; // resolved tenant
    }
  }
}

// ── JWT verification ─────────────────────────────────────────
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);

  // Check token blacklist (logout / rotation)
  const blacklisted = await redis.get(`bl:${token}`);
  if (blacklisted) return res.status(401).json({ error: 'Token revoked' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;
    req.user = payload;
    req.schoolId = payload.schoolId ?? undefined;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Role guard factory ────────────────────────────────────────
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ── Tenant isolation ─────────────────────────────────────────
// Resolves schoolId from JWT, subdomain header, or URL param.
// Every tenant-scoped route MUST call this after authenticate().
export async function resolveTenant(req: Request, res: Response, next: NextFunction) {
  // 1. SUPER_ADMIN can target any school via header
  if (req.user?.role === Role.SUPER_ADMIN) {
    const targetSchool = req.headers['x-school-id'] as string | undefined;
    if (targetSchool) req.schoolId = targetSchool;
    return next();
  }

  // 2. Regular users: schoolId comes from JWT
  if (!req.user?.schoolId) {
    return res.status(400).json({ error: 'No school context' });
  }

  // 3. Cache school lookup to avoid DB hit on every request
  const cacheKey = `school:${req.user.schoolId}:active`;
  const cached = await redis.get(cacheKey);
  if (!cached) {
    try {
      const school = await prisma.school.findUnique({
        where: { id: req.user.schoolId },
        select: { id: true, subscription: { select: { status: true } } },
      });
      if (!school) return res.status(403).json({ error: 'School not found' });
      await redis.setex(cacheKey, 300, JSON.stringify(school));
    } catch (err: any) {
      // Neon cold-start: DB temporarily unreachable — trust the JWT and continue
      // The next request will retry after Neon wakes up
      if (err?.message?.includes("Can't reach database")) {
        console.warn('[resolveTenant] DB cold-start, passing through on JWT trust');
        req.schoolId = req.user.schoolId;
        return next();
      }
      return res.status(503).json({ error: 'Database temporarily unavailable, please retry in a moment' });
    }
  }

  req.schoolId = req.user.schoolId;
  next();
}

// ── Subscription enforcement ──────────────────────────────────
export async function requireActiveSubscription(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role === Role.SUPER_ADMIN) return next();

  const cacheKey = `sub:${req.schoolId}`;
  let status: string | null = await redis.get(cacheKey);

  if (!status) {
    const sub = await prisma.subscription.findUnique({
      where: { schoolId: req.schoolId! },
      select: { status: true, trialEndsAt: true },
    });
    status = sub?.status ?? 'NONE';
    await redis.setex(cacheKey, 60, status);
  }

  if (status === 'TRIAL') {
    // still valid — pass through
    return next();
  }
  if (status !== 'ACTIVE') {
    return res.status(402).json({
      error: 'Subscription inactive',
      code: 'SUBSCRIPTION_REQUIRED',
    });
  }
  next();
}
