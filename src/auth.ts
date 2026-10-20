import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { RequestHandler } from 'express';
import type { Db } from './db.ts';

const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LEN = 64;

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Solo se guarda el hash del token: si se filtra la BD, los tokens no sirven. */
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export async function createSession(db: Db, userId: number, deviceName: string | null, ttlMs: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.execute({
    sql: 'INSERT INTO sessions (token_hash, user_id, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    args: [hashToken(token), userId, deviceName, now, now + ttlMs],
  });
  return token;
}

interface SessionRow {
  token_hash: string;
  expires_at: number;
  id: number;
  email: string;
}

/** Exige `Authorization: Bearer <token>`. La sesión se renueva sola cuando pasa la mitad de su vida. */
export function requireAuth(db: Db, ttlMs: number): RequestHandler {
  return async (req, _res, next) => {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Falta el token de sesión.');

    const now = Date.now();
    const { rows } = await db.execute({
      sql: `SELECT s.token_hash, s.expires_at, u.id, u.email
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?`,
      args: [hashToken(token), now],
    });
    const row = rows[0] as unknown as SessionRow | undefined;
    if (!row) throw new HttpError(401, 'Sesión inválida o vencida.');

    if (row.expires_at - now < ttlMs / 2) {
      await db.execute({ sql: 'UPDATE sessions SET expires_at = ? WHERE token_hash = ?', args: [now + ttlMs, row.token_hash] });
    }
    req.user = { id: row.id, email: row.email };
    req.tokenHash = row.token_hash;
    next();
  };
}
