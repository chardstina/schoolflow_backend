import { Router } from 'express';
import { exec } from 'child_process';

const router = Router();

router.post('/run', (req, res) => {
  const key = req.headers['x-seed-key'];
  if (!process.env.JWT_SECRET || key !== process.env.JWT_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  exec('npx tsx src/seed.ts', { cwd: process.cwd(), timeout: 60000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: stderr || err.message, stdout });
    }
    res.json({ ok: true, output: stdout });
  });
});

export default router;
