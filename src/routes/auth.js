import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { HttpError, createSession, hashPassword, verifyPassword } from '../auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

function readCredentials(body) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const deviceName = typeof body?.deviceName === 'string' ? body.deviceName.slice(0, 100) : null;
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Email inválido.');
  if (password.length < MIN_PASSWORD || password.length > 200) {
    throw new HttpError(400, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
  }
  return { email, password, deviceName };
}

export function authRouter(db, { sessionTtlMs, requireAuth }) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

  const findUser = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?');
  const insertUser = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)');
  // Para que el login tarde lo mismo exista o no el usuario.
  const dummyHash = hashPassword('dummy-password');

  router.post('/register', limiter, async (req, res) => {
    const { email, password, deviceName } = readCredentials(req.body);
    if (findUser.get(email)) throw new HttpError(409, 'Ese email ya está registrado.');

    const passwordHash = await hashPassword(password);
    const { lastInsertRowid } = insertUser.run(email, passwordHash, Date.now());
    const userId = Number(lastInsertRowid);
    const token = createSession(db, userId, deviceName, sessionTtlMs);
    res.status(201).json({ token, user: { id: userId, email } });
  });

  router.post('/login', limiter, async (req, res) => {
    const { email, password, deviceName } = readCredentials(req.body);
    const user = findUser.get(email);
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash));
    if (!user || !ok) throw new HttpError(401, 'Email o contraseña incorrectos.');

    const token = createSession(db, user.id, deviceName, sessionTtlMs);
    res.json({ token, user: { id: user.id, email: user.email } });
  });

  router.post('/logout', requireAuth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.tokenHash);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
