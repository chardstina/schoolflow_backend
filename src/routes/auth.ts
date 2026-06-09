import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../utils/prisma';
import { redis } from '../utils/redis';
import { authenticate } from '../middleware/auth';
import type { AuthPayload } from '../middleware/auth';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });

  const { email, password } = parse.data;

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true, email: true, passwordHash: true,
      role: true, schoolId: true, isActive: true,
      firstName: true, lastName: true,
    },
  });

  if (!user || !user.isActive) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const payload: AuthPayload = {
    userId: user.id,
    schoolId: user.schoolId,
    role: user.role,
    email: user.email,
  };

  const accessToken = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '8h' });
  const refreshToken = jwt.sign({ userId: user.id }, process.env.JWT_REFRESH_SECRET!, {
    expiresIn: '30d',
  });

  // Store refresh token in Redis
  await redis.setex(`rt:${user.id}`, 60 * 60 * 24 * 30, refreshToken);

  // Update last login
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return res.json({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      name: `${user.firstName} ${user.lastName}`,
      role: user.role,
      schoolId: user.schoolId,
    },
  });
});

// POST /auth/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as { userId: string };
    const stored = await redis.get(`rt:${decoded.userId}`);
    if (stored !== refreshToken) return res.status(401).json({ error: 'Invalid refresh token' });

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, role: true, schoolId: true, isActive: true },
    });
    if (!user || !user.isActive) return res.status(401).json({ error: 'User not found' });

    const newAccess = jwt.sign(
      { userId: user.id, schoolId: user.schoolId, role: user.role, email: user.email } as AuthPayload,
      process.env.JWT_SECRET!,
      { expiresIn: '8h' }
    );
    return res.json({ accessToken: newAccess });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// POST /auth/logout
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  const token = req.headers.authorization!.slice(7);
  // Blacklist current access token until its natural expiry (~8h)
  await redis.setex(`bl:${token}`, 8 * 60 * 60, '1');
  // Remove refresh token
  await redis.del(`rt:${req.user!.userId}`);
  return res.json({ message: 'Logged out successfully' });
});

// POST /auth/change-password
router.post('/change-password', authenticate, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Invalid password data' });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  return res.json({ message: 'Password updated' });
});

export default router;
