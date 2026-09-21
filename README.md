# demo-cleaning-backend

Backend white-label de servicios de limpieza (fork de Monkey Cleaning). **Una instancia por cliente** (Render + Supabase + env).

## Blog: modos `off` | `manual` | `auto`

La preferencia vive en la tabla `site_settings` (no en env). El cliente la cambia desde Settings sin reiniciar.

| Modo guardado | Entitlement (`auto_addon_status === 'active'`) | Modo efectivo |
|---|---|---|
| `off` | — | `off` |
| `manual` | — | `manual` |
| `auto` | sí | `auto` |
| `auto` | no | **`manual`** (degradación) + si eligió auto se marca `auto_addon_status = 'requested'` |

- **`off`**: API pública de blogs → 404; CRUD admin → 403 `blog_disabled`. No borra posts.
- **`manual`**: CRUD admin completo. Ingest de plataforma: solo `status: "draft"` sobre `external_id` existente (despublicar). Crear/publicar → 409 `blog_auto_disabled`.
- **`auto`**: ingest completo. Posts con `source = 'seo-blog-platform'` no se editan/borran desde admin (403 `blog_managed_by_platform`). Posts manuales (`source` null o `'admin'`) sí.

### Activar el addon auto (hoy, sin cobro)

1. Aplicar migración `db/migrations/20260921_site_settings_blog_mode.sql`.
2. Admin: `PUT /api/admin/settings/blog` con `{ "blog_mode": "auto" }` → queda `requested` si aún no hay entitlement.
3. Ops / plataforma: `PUT /api/internal/content/addon` con Bearer `SEO_BLOG_PLATFORM_SERVICE_TOKEN` y `{ "auto_addon_status": "active" }` — **única vía a `active`**.
4. Efectivo pasa a `auto` (cache ~30s; el PUT invalida).

Cuando exista cobro (Stripe / Mercado Pago), el webhook de pago debería llamar al mismo `PUT .../addon` (o `setAutoAddonStatus`).

### Instancias que ya reciben blogs de la plataforma (Monkey)

Tras la migración (default `manual` / `inactive`), corré:

```sql
UPDATE site_settings
SET blog_mode = 'auto',
    auto_addon_status = 'active',
    updated_at = now()
WHERE id = 1;
```

Así el ingest sigue aceptando create/publish como antes de este cambio.

---

## Checklist: levantar un cliente nuevo

1. Clonar este repo / nuevo servicio Render.
2. Proyecto Supabase nuevo; aplicar migraciones en `db/migrations/` (incluida `site_settings`).
3. Bucket Storage `blog-images` (público si el front sirve heroes desde ahí).
4. Env mínimas (ver abajo). En **production** `PUBLIC_SITE_URL` es **obligatoria**.
5. Front: apuntar API; consumir `GET /api/site-config` para nav `/blog`.
6. Modo inicial: dejar `manual` (default) o `off`. Si van a usar seo-blog-platform, seguir “Activar el addon auto”.
7. CORS: sumar el dominio del front en `src/index.js` (hoy hardcodeado) o parametrizar en un follow-up.

---

## Variables de entorno

### Obligatorias (siempre)

| Variable | Descripción |
|---|---|
| `SUPABASE_URL` | URL del proyecto |
| `SUPABASE_SERVICE_KEY` | Service role (bypassa RLS) |
| `ADMIN_JWT_SECRET` | Firma JWT admin |
| `ADMIN_BLOG_PASSWORD` / `PASS_*` | Login admin (legacy / usuarios) |

### Obligatorias en `NODE_ENV=production`

| Variable | Descripción |
|---|---|
| `PUBLIC_SITE_URL` | Origen público del **frontend** (sitemap + `public_url` del ingest). Ej. `https://monkeycleaning.com` |

### Blog / SEO (recomendadas)

| Variable | Default | Descripción |
|---|---|---|
| `SEO_BLOG_PLATFORM_SERVICE_TOKEN` | — | Bearer server-to-server (ingest, status, addon). **Obligatoria** si usás auto. |
| `SEO_BLOG_DEFAULT_AUTHOR` | `BRAND_NAME` o `"Blog"` | Author de posts ingestados |
| `SEO_BLOG_ALLOWED_CLIENT_SLUGS` | (vacío = no validar) | Allowlist coma-separada de `client_slug` |
| `BRAND_NAME` | `"Cleaning Co."` | Marca neutra |
| `SITE_SITEMAP_STATIC_ROUTES` | `[{"path":"/","priority":"1.0"}]` | JSON de rutas estáticas del sitemap. `/blog` y posts se agregan solo si el modo efectivo ≠ `off`. |
| `FRONTEND_URL` | — | Fallback de `PUBLIC_SITE_URL` si esta última falta (no alcanza en prod) |

### Ejemplo Monkey (paridad)

```env
PUBLIC_SITE_URL=https://monkeycleaning.com
SEO_BLOG_DEFAULT_AUTHOR=Monkey Cleaning
SEO_BLOG_ALLOWED_CLIENT_SLUGS=monkey
SEO_BLOG_PLATFORM_SERVICE_TOKEN=<token>
SITE_SITEMAP_STATIC_ROUTES=[{"path":"/","priority":"1.0"},{"path":"/contact-us","priority":"0.9"},{"path":"/privacy","priority":"0.3"},{"path":"/services/general","priority":"0.7"},{"path":"/services/general/residential","priority":"0.8"},{"path":"/services/general/commercial","priority":"0.8"},{"path":"/services/general/offices","priority":"0.8"},{"path":"/services/specialized","priority":"0.7"},{"path":"/services/specialized/tile","priority":"0.8"},{"path":"/services/specialized/carpet","priority":"0.8"}]
```

Más el `UPDATE` de addon activo arriba.

---

## Contratos útiles

### `GET /api/site-config` (público)

```json
{ "blogEnabled": true, "blogMode": "manual" }
```

### `GET /api/admin/settings/blog` / `PUT` body `{ "blog_mode": "off"|"manual"|"auto" }`

```json
{
  "ok": true,
  "blog_mode": "auto",
  "effective_mode": "manual",
  "auto_addon_status": "requested",
  "entitled": false
}
```

### `GET /api/internal/content/status` (Bearer service token)

```json
{ "mode": "manual", "entitled": false, "auto_addon_status": "requested" }
```

### `PUT /api/internal/content/addon` (Bearer)

```json
{ "auto_addon_status": "active" }
```

### `POST /api/internal/content/blogs` (Bearer) — éxito

```json
{
  "success": true,
  "post_id": "<uuid>",
  "slug": "hello-world",
  "public_url": "https://example.com/blog/hello-world",
  "action": "created"
}
```

Fuera de auto sin draft-existente: `409 { "success": false, "code": "blog_auto_disabled", "mode": "manual" }`.

---

## Probar

```bash
# Status
curl -s http://localhost:4000/api/internal/content/status \
  -H "Authorization: Bearer $SEO_BLOG_PLATFORM_SERVICE_TOKEN"

# Activar addon
curl -s -X PUT http://localhost:4000/api/internal/content/addon \
  -H "Authorization: Bearer $SEO_BLOG_PLATFORM_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"auto_addon_status":"active"}'

# Admin: modo auto
curl -s -X PUT http://localhost:4000/api/admin/settings/blog \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"blog_mode":"auto"}'

# Ingest publish
curl -s -X POST http://localhost:4000/api/internal/content/blogs \
  -H "Authorization: Bearer $SEO_BLOG_PLATFORM_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"external_id":"demo-1","slug":"hello-world","title":"Hello","body_markdown":"## Intro\nHola","status":"published","client_slug":"monkey"}'

# Despublicar (también funciona si efectivo != auto)
curl -s -X POST http://localhost:4000/api/internal/content/blogs \
  -H "Authorization: Bearer $SEO_BLOG_PLATFORM_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"external_id":"demo-1","slug":"hello-world","title":"Hello","body_markdown":"## Intro\nHola","status":"draft"}'

# Site config
curl -s http://localhost:4000/api/site-config
```

Sin token / token inválido → `401`. Payload inválido → `400` con `details`.

---

## RLS

- `site_settings`: **ENABLE ROW LEVEL SECURITY** sin policies (solo service role).
- `blog_posts` / `blog_sections`: **no hay migraciones de RLS en este repo**. Revisar en el dashboard de Supabase de cada proyecto (`pg_tables` / Auth policies). Si están públicas vía anon key, el front no debería usar anon para escribir; este backend siempre usa service role.

## Scripts

```bash
npm run dev    # node src/index.js
npm start
npm test
```
