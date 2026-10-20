import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DATABASE_PATH ?? './data/titan.sqlite';
const sessionTtlMs = Number(process.env.SESSION_TTL_DAYS ?? 90) * 24 * 60 * 60 * 1000;

const db = openDb(dbPath);
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

const server = createApp(db, { sessionTtlMs }).listen(port, () => {
  console.log(`TITAN API escuchando en :${port} (BD: ${dbPath})`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
