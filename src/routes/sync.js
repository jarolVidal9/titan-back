import { Router } from 'express';
import { HttpError } from '../auth.js';

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

function parseChange(c, i) {
  const bad = (msg) => new HttpError(400, `changes[${i}]: ${msg}`);
  if (typeof c !== 'object' || c === null) throw bad('debe ser un objeto.');
  if (!SYNC_TABLES.has(c.table)) throw bad(`tabla desconocida "${c.table}".`);
  if (typeof c.uid !== 'string' || c.uid.length === 0 || c.uid.length > 64) throw bad('uid inválido.');
  if (!Number.isSafeInteger(c.updatedAt) || c.updatedAt <= 0) throw bad('updatedAt debe ser ms epoch.');

  const deleted = c.deleted === true;
  let data = null;
  if (!deleted) {
    if (typeof c.data !== 'object' || c.data === null || Array.isArray(c.data)) throw bad('data debe ser un objeto.');
    data = JSON.stringify(c.data);
    if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw bad('el registro es demasiado grande.');
  }
  return { table: c.table, uid: c.uid, updatedAt: c.updatedAt, deleted, data };
}

const toChange = (r) => ({
  table: r.tbl,
  uid: r.uid,
  data: r.data === null ? null : JSON.parse(r.data),
  updatedAt: r.updated_at,
  deleted: r.deleted === 1,
});

export function syncRouter(db) {
  const router = Router();

  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM records WHERE user_id = ?');
  const getRecord = db.prepare('SELECT * FROM records WHERE user_id = ? AND tbl = ? AND uid = ?');
  const upsert = db.prepare(`
    INSERT INTO records (user_id, tbl, uid, data, updated_at, deleted, device_id, seq)
    VALUES (@userId, @table, @uid, @data, @updatedAt, @deleted, @deviceId, @seq)
    ON CONFLICT (user_id, tbl, uid) DO UPDATE SET
      data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted,
      device_id = excluded.device_id, seq = excluded.seq`);
  const pull = db.prepare(`
    SELECT * FROM records WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?`);

  const push = db.transaction((userId, deviceId, changes) => {
    let seq = maxSeq.get(userId).seq;
    let applied = 0;
    const conflicts = [];
    for (const c of changes) {
      const current = getRecord.get(userId, c.table, c.uid);
      if (current && current.updated_at >= c.updatedAt) {
        // Empate del mismo dispositivo = reintento del mismo cambio: no es conflicto.
        const retry = current.updated_at === c.updatedAt && current.device_id === deviceId;
        if (!retry) conflicts.push(toChange(current));
        continue;
      }
      upsert.run({ ...c, userId, deviceId, deleted: c.deleted ? 1 : 0, seq: ++seq });
      applied++;
    }
    return { applied, conflicts };
  });

  /**
   * Push + pull en una sola llamada.
   * Body: { deviceId, since, changes: [{ table, uid, data, updatedAt, deleted }] }
   * Respuesta: { applied, conflicts, changes, cursor, hasMore }
   */
  router.post('/', (req, res) => {
    const body = req.body ?? {};
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : null;
    const since = Number.isSafeInteger(body.since) && body.since >= 0 ? body.since : 0;
    const raw = body.changes ?? [];
    if (!Array.isArray(raw)) throw new HttpError(400, 'changes debe ser una lista.');
    if (raw.length > MAX_PUSH) throw new HttpError(413, `Máximo ${MAX_PUSH} cambios por llamada.`);

    const { applied, conflicts } = push(req.user.id, deviceId, raw.map(parseChange));

    const rows = pull.all(req.user.id, since, PULL_LIMIT + 1);
    const hasMore = rows.length > PULL_LIMIT;
    if (hasMore) rows.pop();
    const cursor = rows.length ? rows[rows.length - 1].seq : since;

    res.json({ applied, conflicts, changes: rows.map(toChange), cursor, hasMore });
  });

  return router;
}
