import express, { type ErrorRequestHandler } from 'express';
import { HttpError, requireAuth } from './auth.ts';
import type { Db } from './db.ts';
import { authRouter } from './routes/auth.ts';
import { syncRouter } from './routes/sync.ts';

export function createApp(db: Db, { sessionTtlMs, corsOrigins = [] }: { sessionTtlMs: number; corsOrigins?: string[] }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render va detrás de un proxy: IP real para el rate limit.

  // El front web (Angular) llama desde otro dominio. Se autentica con Bearer, no con cookies.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && (corsOrigins.includes('*') || corsOrigins.includes(origin))) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      });
    }
    if (req.method === 'OPTIONS') return void res.status(204).end();
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  const auth = requireAuth(db, sessionTtlMs);

  app.get('/health', (_req, res) => void res.json({ ok: true }));
  app.use('/auth', authRouter(db, { sessionTtlMs, requireAuth: auth }));
  app.use('/sync', auth, syncRouter(db));

  app.use((_req, _res, next) => next(new HttpError(404, 'Ruta no encontrada.')));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status: number = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Error interno del servidor.' : err.message;
    res.status(status).json({ error: message });
  };
  app.use(onError);

  return app;
}
