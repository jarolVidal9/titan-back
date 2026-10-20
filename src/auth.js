import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Solo se guarda el hash del token: si se filtra la BD, los tokens no sirven. */
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(db, userId, deviceName, ttlMs) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(hashToken(token), userId, deviceName ?? null, now, now + ttlMs);
  return token;
}

/** Exige `Authorization: Bearer <token>`. La sesión se renueva sola cuando pasa la mitad de su vida. */
export function requireAuth(db, ttlMs) {
  const find = db.prepare(`
    SELECT s.token_hash, s.expires_at, u.id, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`);
  const extend = db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?');

  return (req, _res, next) => {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) return next(new HttpError(401, 'Falta el token de sesión.'));

    const now = Date.now();
    const row = find.get(hashToken(token), now);
    if (!row) return next(new HttpError(401, 'Sesión inválida o vencida.'));

    if (row.expires_at - now < ttlMs / 2) extend.run(now + ttlMs, row.token_hash);
    req.user = { id: row.id, email: row.email };
    req.tokenHash = row.token_hash;
    next();
  };
}
