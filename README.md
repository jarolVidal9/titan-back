# TITAN API

Backend de TITAN: sesión y sincronización offline-first. Node 24 + Express 5 + TypeScript + Turso (libSQL).

Node ejecuta los `.ts` directamente (type stripping), así que no hay paso de compilación; `tsc` solo revisa tipos.

```bash
npm install
cp .env.example .env   # y llenar TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
npm run dev            # http://localhost:3000
npm run typecheck
npm test               # usa un SQLite temporal, no toca Turso
```

| Variable             | Por defecto                 |                                                |
|----------------------|-----------------------------|------------------------------------------------|
| `TURSO_DATABASE_URL` | `file:./data/titan.sqlite`  | `libsql://…` para Turso, `file:` para local    |
| `TURSO_AUTH_TOKEN`   | —                           | Token de Turso                                 |
| `SESSION_TTL_DAYS`   | `90`                        |                                                |
| `CORS_ORIGINS`       | —                           | Orígenes del front web separados por coma      |
| `PORT`               | `3000`                      |                                                |

Las tablas se crean solas al arrancar.

## Despliegue en Render

New → Blueprint → este repo. `render.yaml` crea el servicio en el plan free; en el panel hay que llenar
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` y `CORS_ORIGINS` (no se suben al repo).
En el plan free el servicio se duerme tras 15 min sin uso y la primera llamada tarda ~1 min; como los clientes
funcionan offline, solo retrasa la sincronización.

## Sesión

Todas las rutas salvo `/health`, `/auth/register` y `/auth/login` piden `Authorization: Bearer <token>`.
La sesión dura `SESSION_TTL_DAYS` y se renueva sola con el uso.

| Método | Ruta             | Body                                  | Respuesta                  |
|--------|------------------|---------------------------------------|----------------------------|
| POST   | `/auth/register` | `{ email, password, deviceName? }`    | `201 { token, user }`      |
| POST   | `/auth/login`    | `{ email, password, deviceName? }`    | `{ token, user }`          |
| POST   | `/auth/logout`   | —                                     | `204`                      |
| GET    | `/auth/me`       | —                                     | `{ user }`                 |

## Sincronización: `POST /sync`

Push y pull en una sola llamada:

```json
{
  "deviceId": "uuid-del-dispositivo",
  "since": 0,
  "changes": [
    { "table": "exercises", "uid": "9b1c…", "data": { "name": "Press banca" }, "updatedAt": 1760000000000 },
    { "table": "workout_sets", "uid": "a7f2…", "deleted": true, "updatedAt": 1760000005000 }
  ]
}
```

```json
{ "applied": 2, "conflicts": [], "changes": [ … ], "cursor": 42, "hasMore": false }
```

- `table`: una de las tablas de la app en snake_case (lista en `src/routes/sync.ts`).
- `uid`: id global del registro (UUID). Las referencias dentro de `data` también deben ser UIDs, no los ids locales.
- `updatedAt`: ms epoch de la última edición. Gana la más reciente (last-write-wins).
- Borrar = mandar `deleted: true` (tombstone), para que los otros dispositivos se enteren.
- `conflicts`: los cambios que perdieron, con la versión que quedó en el servidor.
- `changes`: todo lo que cambió en el servidor después de `since` (máx. 1000). Guardar `cursor` y, si `hasMore`,
  volver a llamar con `changes: []` y `since: cursor`.

Ciclo del cliente: guardar local siempre → marcar el registro como pendiente → al tener red, enviar pendientes →
aplicar `changes` y `conflicts` solo si su `updatedAt` es mayor que el local → guardar `cursor`.
