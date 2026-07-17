import 'dotenv/config';  // Must be first — loads .env before any other module reads process.env

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import { authRouter } from './routes/auth';
import { doctorsRouter } from './routes/doctors';
import { appointmentsRouter } from './routes/appointments';
import { chatRouter } from './routes/chat';
import { cycleRouter } from './routes/cycle';
import { programsRouter } from './routes/programs';
import { wellnessRouter } from './routes/wellness';
import { articlesRouter } from './routes/articles';
import { healthRouter } from './routes/health';
import { communityRouter } from './routes/community';
import { membershipRouter } from './routes/membership';
import { adminRouter } from './routes/admin';
import { doctorPortalRouter } from './routes/doctor-portal';

const app = express();
const PORT = process.env.PORT || 4000;

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow any origin dynamically to support Vercel preview branches
      callback(null, true);
    },
    credentials: true,
  })
);

// ─── Health check ───────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/doctors', doctorsRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/cycle', cycleRouter);
app.use('/api/programs', programsRouter);
app.use('/api/wellness', wellnessRouter);
app.use('/api/articles', articlesRouter);
app.use('/api/health-records', healthRouter);
app.use('/api/community', communityRouter);
app.use('/api/membership', membershipRouter);
app.use('/api/admin', adminRouter);
app.use('/api/doctor-portal', doctorPortalRouter);

// ─── 404 handler ────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── Error handler ──────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🌸 SheBloom API running on http://localhost:${PORT}`);
});

export default app;
