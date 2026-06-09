/**
 * Photo upload endpoint — stores base64 image as Data URL in DB photoUrl field.
 * For production, replace with S3/Cloudinary upload.
 */
import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate, resolveTenant, requireRole } from '../middleware/auth';
import { Role } from '@prisma/client';

const router = Router();
router.use(authenticate, resolveTenant);

// POST /upload/student/:id/photo
// Body: { photo: "data:image/jpeg;base64,..." }
router.post('/student/:id/photo', requireRole(Role.SCHOOL_ADMIN), async (req: Request, res: Response) => {
  const { photo } = req.body;

  if (!photo || !photo.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Invalid image data. Send a base64 data URL.' });
  }

  // Max ~2MB base64 check
  if (photo.length > 3_000_000) {
    return res.status(400).json({ error: 'Image too large. Maximum 2MB.' });
  }

  const updated = await prisma.student.updateMany({
    where: { id: req.params.id, schoolId: req.schoolId! },
    data: { photoUrl: photo },
  });

  if (updated.count === 0) return res.status(404).json({ error: 'Student not found' });

  return res.json({ photoUrl: photo.slice(0, 50) + '…', message: 'Photo updated' });
});

export default router;
