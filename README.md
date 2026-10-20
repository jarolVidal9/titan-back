# TITAN API

Backend de TITAN: sesión y sincronización offline-first. Node + Express 5 + SQLite (better-sqlite3).

```bash
npm install
npm run dev     # http://localhost:3000 (lee .env si existe)
npm test
```

Variables: `PORT`, `DATABASE_PATH` (por defecto `./data/titan.sqlite`), `SESSION_TTL_DAYS` (por defecto 90).

## Despliegue en Render

`render.yaml` crea el servicio con un disco persistente montado en `/var/data`. Sin ese disco
(plan free) el archivo SQLite se borra en cada deploy o reinicio.

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

- `table`: una de las tablas de la app en snake_case (lista en `src/routes/sync.js`).
- `uid`: id global del registro (UUID). Las referencias dentro de `data` también deben ser UIDs, no los ids locales.
- `updatedAt`: ms epoch de la última edición. Gana la más reciente (last-write-wins).
- Borrar = mandar `deleted: true` (tombstone), para que los otros dispositivos se enteren.
- `conflicts`: los cambios que perdieron, con la versión que quedó en el servidor.
- `changes`: todo lo que cambió en el servidor después de `since` (máx. 1000). Guardar `cursor` y, si `hasMore`,
  volver a llamar con `changes: []` y `since: cursor`.

Ciclo del cliente: guardar local siempre → marcar el registro como pendiente → al tener red, enviar pendientes →
aplicar `changes` y `conflicts` solo si su `updatedAt` es mayor que el local → guardar `cursor`.
