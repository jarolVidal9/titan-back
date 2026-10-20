import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';

let server;
let base;

before(async () => {
  const app = createApp(openDb(':memory:'), { sessionTtlMs: 60_000 });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

test('registro, login, me y logout', async () => {
  const reg = await call('POST', '/auth/register', { body: { email: 'A@Test.com', password: 'secreta123' } });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.email, 'a@test.com');

  assert.equal((await call('POST', '/auth/register', { body: { email: 'a@test.com', password: 'secreta123' } })).status, 409);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'a@test.com', password: 'mala12345' } })).status, 401);

  const login = await call('POST', '/auth/login', { body: { email: 'a@test.com', password: 'secreta123' } });
  assert.equal(login.status, 200);

  const me = await call('GET', '/auth/me', { token: login.body.token });
  assert.equal(me.body.user.email, 'a@test.com');

  assert.equal((await call('POST', '/auth/logout', { token: login.body.token })).status, 204);
  assert.equal((await call('GET', '/auth/me', { token: login.body.token })).status, 401);
  assert.equal((await call('GET', '/auth/me')).status, 401);
});

test('sync: push, pull incremental, last-write-wins y aislamiento entre usuarios', async () => {
  const { body: u1 } = await call('POST', '/auth/register', { body: { email: 'u1@test.com', password: 'secreta123' } });
  const { body: u2 } = await call('POST', '/auth/register', { body: { email: 'u2@test.com', password: 'secreta123' } });

  const ex = { table: 'exercises', uid: 'ex-1', data: { name: 'Press banca' }, updatedAt: 1000 };
  const first = await call('POST', '/sync', { token: u1.token, body: { deviceId: 'A', since: 0, changes: [ex] } });
  assert.equal(first.body.applied, 1);
  assert.equal(first.body.changes.length, 1);
  const cursor = first.body.cursor;

  // Reintento idéntico del mismo dispositivo: ni se aplica ni es conflicto.
  const retry = await call('POST', '/sync', { token: u1.token, body: { deviceId: 'A', since: cursor, changes: [ex] } });
  assert.equal(retry.body.applied, 0);
  assert.equal(retry.body.conflicts.length, 0);

  // Dispositivo B edita después: gana.
  const newer = { ...ex, data: { name: 'Press inclinado' }, updatedAt: 2000 };
  assert.equal((await call('POST', '/sync', { token: u1.token, body: { deviceId: 'B', since: cursor, changes: [newer] } })).body.applied, 1);

  // A manda una edición más vieja: pierde y recibe la versión del servidor como conflicto.
  const stale = await call('POST', '/sync', {
    token: u1.token,
    body: { deviceId: 'A', since: cursor, changes: [{ ...ex, data: { name: 'Viejo' }, updatedAt: 1500 }] },
  });
  assert.equal(stale.body.applied, 0);
  assert.equal(stale.body.conflicts[0].data.name, 'Press inclinado');
  assert.deepEqual(stale.body.changes.map((c) => c.data.name), ['Press inclinado']);

  // Borrado (tombstone).
  const del = await call('POST', '/sync', {
    token: u1.token,
    body: { deviceId: 'A', since: stale.body.cursor, changes: [{ table: 'exercises', uid: 'ex-1', deleted: true, updatedAt: 3000 }] },
  });
  assert.deepEqual(del.body.changes, [{ table: 'exercises', uid: 'ex-1', data: null, updatedAt: 3000, deleted: true }]);

  // El otro usuario no ve nada.
  const other = await call('POST', '/sync', { token: u2.token, body: { since: 0 } });
  assert.deepEqual(other.body.changes, []);
  assert.equal(other.body.cursor, 0);
});

test('sync: valida la entrada y exige sesión', async () => {
  const { body: u } = await call('POST', '/auth/register', { body: { email: 'v@test.com', password: 'secreta123' } });
  assert.equal((await call('POST', '/sync', { body: { since: 0 } })).status, 401);

  const badTable = await call('POST', '/sync', {
    token: u.token,
    body: { changes: [{ table: 'users', uid: 'x', data: {}, updatedAt: 1 }] },
  });
  assert.equal(badTable.status, 400);

  const noData = await call('POST', '/sync', {
    token: u.token,
    body: { changes: [{ table: 'exercises', uid: 'x', updatedAt: 1 }] },
  });
  assert.equal(noData.status, 400);
});

test('sync: paginación con hasMore', async () => {
  const { body: u } = await call('POST', '/auth/register', { body: { email: 'p@test.com', password: 'secreta123' } });
  const changes = Array.from({ length: 1000 }, (_, i) => ({ table: 'workout_sets', uid: `s-${i}`, data: { reps: i }, updatedAt: 1 }));
  await call('POST', '/sync', { token: u.token, body: { changes } });
  await call('POST', '/sync', { token: u.token, body: { changes: [{ table: 'workout_sets', uid: 'extra', data: {}, updatedAt: 1 }] } });

  const page1 = await call('POST', '/sync', { token: u.token, body: { since: 0 } });
  assert.equal(page1.body.changes.length, 1000);
  assert.equal(page1.body.hasMore, true);

  const page2 = await call('POST', '/sync', { token: u.token, body: { since: page1.body.cursor } });
  assert.equal(page2.body.changes.length, 1);
  assert.equal(page2.body.hasMore, false);
});
