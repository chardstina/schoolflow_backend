import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

// Routes
import authRoutes from './routes/auth';
import feesRoutes from './routes/fees';
import resultsRoutes from './routes/results';
import subscriptionRoutes from './routes/subscriptions';
import adminRoutes from './routes/admin';
import parentRoutes from './routes/parent';
import studentRoutes from './routes/students';
import uploadRoutes from './routes/upload';
import paymentProofRoutes from './routes/paymentProofs';
import seedRunnerRoutes from './routes/_seedRunner';

// Jobs (register cron on import)
import './jobs/billingCron';

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*', credentials: true }));
app.use(express.json());
app.use(morgan('dev'));

// Health
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Paystack webhook — needs raw body for signature verification
app.use('/api/fees/pay/webhook', express.raw({ type: 'application/json' }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/fees', feesRoutes);
app.use('/api/results', resultsRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/teacher', adminRoutes); // shares same router — /teacher/my-classes resolves correctly
app.use('/api/parent', parentRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/payment-proofs', paymentProofRoutes);
app.use('/api/_internal/seed', seedRunnerRoutes);

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err);
  res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' });
});

const PORT = Number(process.env.PORT ?? 4000);
app.listen(PORT, () => console.log(`🚀 SchoolFlow API running on port ${PORT}`));
