import fs from 'node:fs';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';

export type Db = Client;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Una fila por registro de la app. El servidor no conoce el esquema de la app:
-- guarda el JSON tal cual y solo decide quién gana (last-write-wins por updated_at).
CREATE TABLE IF NOT EXISTS records (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tbl        TEXT    NOT NULL,
  uid        TEXT    NOT NULL,
  data       TEXT,                       -- JSON; NULL si está borrado
  updated_at INTEGER NOT NULL,           -- ms epoch, lo pone el cliente
  deleted    INTEGER NOT NULL DEFAULT 0,
  device_id  TEXT,
  seq        INTEGER NOT NULL,           -- orden del servidor por usuario, para el pull incremental
  PRIMARY KEY (user_id, tbl, uid)
);
CREATE INDEX IF NOT EXISTS idx_records_seq ON records(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_records_uid ON records(user_id, uid);
`;

/**
 * `url` puede ser Turso (`libsql://…`, con `authToken`) o un archivo local (`file:./data/titan.sqlite`).
 */
export async function openDb({ url, authToken }: { url: string; authToken?: string }): Promise<Db> {
  if (url.startsWith('file:')) {
    fs.mkdirSync(path.dirname(path.resolve(url.slice('file:'.length))), { recursive: true });
  }
  const db = createClient({ url, authToken });
  await db.executeMultiple(SCHEMA);
  return db;
}
