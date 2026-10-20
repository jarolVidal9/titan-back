import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { HttpError, createSession, hashPassword, verifyPassword } from '../auth.ts';
import type { Db } from '../db.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
}

function readCredentials(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const deviceName = typeof b.deviceName === 'string' ? b.deviceName.slice(0, 100) : null;
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Email inválido.');
  if (password.length < MIN_PASSWORD || password.length > 200) {
    throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
  }
  return { email, password, deviceName };
}

export function authRouter(db: Db, { sessionTtlMs, requireAuth }: { sessionTtlMs: number; requireAuth: RequestHandler }) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

  const findUser = async (email: string) =>
    (await db.execute({ sql: 'SELECT id, email, password_hash FROM users WHERE email = ?', args: [email] }))
      .rows[0] as unknown as UserRow | undefined;
  // Para que el login tarde lo mismo exista o no el usuario.
  const dummyHash = hashPassword('dummy-password');

  router.post('/register', limiter, async (req, res) => {
    const { email, password, deviceName } = readCredentials(req.body);
    if (await findUser(email)) throw new HttpError(409, 'Ese email ya está registrado.');

    const passwordHash = await hashPassword(password);
    const { lastInsertRowid } = await db.execute({
      sql: 'INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)',
      args: [email, passwordHash, Date.now()],
    });
    const userId = Number(lastInsertRowid);
    const token = await createSession(db, userId, deviceName, sessionTtlMs);
    res.status(201).json({ token, user: { id: userId, email } });
  });

  router.post('/login', limiter, async (req, res) => {
    const { email, password, deviceName } = readCredentials(req.body);
    const user = await findUser(email);
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash));
    if (!user || !ok) throw new HttpError(401, 'Email o contraseña incorrectos.');

    const token = await createSession(db, user.id, deviceName, sessionTtlMs);
    res.json({ token, user: { id: user.id, email: user.email } });
  });

  router.post('/logout', requireAuth, async (req, res) => {
    await db.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [req.tokenHash!] });
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
