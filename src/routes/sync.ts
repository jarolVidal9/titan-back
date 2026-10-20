import { Router } from 'express';
import type { InStatement } from '@libsql/client';
import { HttpError } from '../auth.ts';
import type { Db } from '../db.ts';

/** Tablas de la app (lib/core/db/tables.dart) en snake_case. Agregar aquí si la app suma tablas. */
export const SYNC_TABLES = new Set([
  'muscle_groups',
  'exercises',
  'exercise_muscle_groups',
  'rep_types',
  'routine_days',
  'routine_day_muscle_groups',
  'routine_day_exercises',
  'workout_sessions',
  'session_muscle_groups',
  'session_exercises',
  'workout_sets',
  'settings',
]);

const MAX_PUSH = 1000;
const PULL_LIMIT = 1000;
const MAX_RECORD_BYTES = 64 * 1024;
const LOOKUP_CHUNK = 500; // uids por consulta al leer lo que ya existe

interface IncomingChange {
  table: string;
  uid: string;
  updatedAt: number;
  deleted: boolean;
  data: string | null; // JSON ya serializado
}

interface RecordRow {
  tbl: string;
  uid: string;
  data: string | null;
  updated_at: number;
  deleted: number;
  device_id: string | null;
  seq: number;
}

function parseChange(raw: unknown, i: number): IncomingChange {
  const bad = (msg: string) => new HttpError(400, `changes[${i}]: ${msg}`);
  if (typeof raw !== 'object' || raw === null) throw bad('debe ser un objeto.');
  const c = raw as Record<string, unknown>;
  if (typeof c.table !== 'string' || !SYNC_TABLES.has(c.table)) throw bad(`tabla desconocida "${c.table}".`);
  if (typeof c.uid !== 'string' || c.uid.length === 0 || c.uid.length > 64) throw bad('uid inválido.');
  if (!Number.isSafeInteger(c.updatedAt) || (c.updatedAt as number) <= 0) throw bad('updatedAt debe ser ms epoch.');

  const deleted = c.deleted === true;
  let data: string | null = null;
  if (!deleted) {
    if (typeof c.data !== 'object' || c.data === null || Array.isArray(c.data)) throw bad('data debe ser un objeto.');
    data = JSON.stringify(c.data);
    if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw bad('el registro es demasiado grande.');
  }
  return { table: c.table, uid: c.uid, updatedAt: c.updatedAt as number, deleted, data };
}

const toChange = (r: RecordRow) => ({
  table: r.tbl,
  uid: r.uid,
  data: r.data === null ? null : JSON.parse(r.data),
  updatedAt: r.updated_at,
  deleted: r.deleted === 1,
});

const key = (table: string, uid: string) => `${table}\u0000${uid}`;

/**
 * Aplica los cambios con last-write-wins dentro de una transacción. Pocas idas y vueltas a Turso:
 * lee lo existente por lotes, decide en memoria y escribe todo en un solo batch.
 */
async function push(db: Db, userId: number, deviceId: string | null, changes: IncomingChange[]) {
  if (changes.length === 0) return { applied: 0, conflicts: [] };

  const tx = await db.transaction('write');
  try {
    const seqRow = await tx.execute({ sql: 'SELECT COALESCE(MAX(seq), 0) AS seq FROM records WHERE user_id = ?', args: [userId] });
    let seq = Number(seqRow.rows[0].seq);

    const existing = new Map<string, RecordRow>();
    const uids = [...new Set(changes.map((c) => c.uid))];
    for (let i = 0; i < uids.length; i += LOOKUP_CHUNK) {
      const chunk = uids.slice(i, i + LOOKUP_CHUNK);
      const { rows } = await tx.execute({
        sql: `SELECT * FROM records WHERE user_id = ? AND uid IN (${chunk.map(() => '?').join(',')})`,
        args: [userId, ...chunk],
      });
      for (const r of rows as unknown as RecordRow[]) existing.set(key(r.tbl, r.uid), r);
    }

    const writes: InStatement[] = [];
    const conflicts: ReturnType<typeof toChange>[] = [];
    for (const c of changes) {
      const k = key(c.table, c.uid);
      const current = existing.get(k);
      if (current && current.updated_at >= c.updatedAt) {
        // Empate del mismo dispositivo = reintento del mismo cambio: no es conflicto.
        const retry = current.updated_at === c.updatedAt && current.device_id === deviceId;
        if (!retry) conflicts.push(toChange(current));
        continue;
      }
      const row: RecordRow = {
        tbl: c.table,
        uid: c.uid,
        data: c.data,
        updated_at: c.updatedAt,
        deleted: c.deleted ? 1 : 0,
        device_id: deviceId,
        seq: ++seq,
      };
      existing.set(k, row); // por si el mismo registro viene repetido en el lote
      writes.push({
        sql: `INSERT INTO records (user_id, tbl, uid, data, updated_at, deleted, device_id, seq)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (user_id, tbl, uid) DO UPDATE SET
                data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted,
                device_id = excluded.device_id, seq = excluded.seq`,
        args: [userId, row.tbl, row.uid, row.data, row.updated_at, row.deleted, row.device_id, row.seq],
      });
    }

    if (writes.length) await tx.batch(writes);
    await tx.commit();
    return { applied: writes.length, conflicts };
  } finally {
    tx.close();
  }
}

export function syncRouter(db: Db) {
  const router = Router();

  /**
   * Push + pull en una sola llamada.
   * Body: { deviceId, since, changes: [{ table, uid, data, updatedAt, deleted }] }
   * Respuesta: { applied, conflicts, changes, cursor, hasMore }
   */
  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : null;
    const since = Number.isSafeInteger(body.since) && (body.since as number) >= 0 ? (body.since as number) : 0;
    const raw = body.changes ?? [];
    if (!Array.isArray(raw)) throw new HttpError(400, 'changes debe ser una lista.');
    if (raw.length > MAX_PUSH) throw new HttpError(413, `Máximo ${MAX_PUSH} cambios por llamada.`);

    const { applied, conflicts } = await push(db, req.user!.id, deviceId, raw.map(parseChange));

    const { rows } = await db.execute({
      sql: 'SELECT * FROM records WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      args: [req.user!.id, since, PULL_LIMIT + 1],
    });
    const records = rows as unknown as RecordRow[];
    const hasMore = records.length > PULL_LIMIT;
    const page = hasMore ? records.slice(0, PULL_LIMIT) : records;
    const cursor = page.length ? page[page.length - 1].seq : since;

    res.json({ applied, conflicts, changes: page.map(toChange), cursor, hasMore });
  });

  return router;
}
