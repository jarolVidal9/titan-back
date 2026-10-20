import { createApp } from './app.ts';
import { openDb } from './db.ts';

const port = Number(process.env.PORT ?? 3000);
const url = process.env.TURSO_DATABASE_URL ?? 'file:./data/titan.sqlite';
const authToken = process.env.TURSO_AUTH_TOKEN;
const sessionTtlMs = Number(process.env.SESSION_TTL_DAYS ?? 90) * 24 * 60 * 60 * 1000;
const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const db = await openDb({ url, authToken });
await db.execute({ sql: 'DELETE FROM sessions WHERE expires_at <= ?', args: [Date.now()] });

const server = createApp(db, { sessionTtlMs, corsOrigins }).listen(port, () => {
  console.log(`TITAN API escuchando en :${port} (BD: ${url.replace(/\?.*$/, '')})`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
