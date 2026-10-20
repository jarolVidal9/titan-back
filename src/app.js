import express from 'express';
import { HttpError, requireAuth } from './auth.js';
import { authRouter } from './routes/auth.js';
import { syncRouter } from './routes/sync.js';

export function createApp(db, { sessionTtlMs }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render va detrás de un proxy: IP real para el rate limit.
  app.use(express.json({ limit: '10mb' }));

  const auth = requireAuth(db, sessionTtlMs);

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/auth', authRouter(db, { sessionTtlMs, requireAuth: auth }));
  app.use('/sync', auth, syncRouter(db));

  app.use((_req, _res, next) => next(new HttpError(404, 'Ruta no encontrada.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    const message = status >= 500 ? 'Error interno del servidor.' : err.message;
    res.status(status).json({ error: message });
  });

  return app;
}
