# demo-cleaning-backend

Plantilla white-label del backend de servicios de limpieza. **Una instancia por cliente** (Render + Supabase + env). Se clona/configura por venta SaaS; no es el backend de ningún cliente concreto.

## Blog: modos `off` | `manual` | `auto`

La preferencia vive en `site_settings` (no en env). El cliente la cambia desde Settings sin reiniciar.

| Modo guardado | Entitlement (`auto_addon_status === 'active'`) | Modo efectivo |
|---|---|---|
| `off` | — | `off` |
| `manual` | — | `manual` |
| `auto` | sí | `auto` |
| `auto` | no | **`manual`** (degradación) + se marca `auto_addon_status = 'requested'` |

Default tras migración: **`blog_mode = 'off'`**, `auto_addon_status = 'inactive'`.

- **`off`**: API pública de blogs → 404; CRUD admin → 403 `blog_disabled`. No borra posts.
- **`manual`**: CRUD admin completo. Ingest de plataforma: solo `status: "draft"` sobre `external_id` existente (despublicar). Crear/publicar → 409 `blog_auto_disabled`.
- **`auto`**: ingest completo. Posts con `source = 'seo-blog-platform'` no se editan/borran desde admin (403 `blog_managed_by_platform`). Posts manuales (`source` null o `'admin'`) sí.

`auto_addon_status` enum: `inactive` | `requested` | `active` | `past_due` (no hay valor `paused`; “pausado” = `inactive` o `past_due`).

### Activar el addon auto (hoy, sin cobro)

1. Aplicar migración `db/migrations/20260921_site_settings_blog_mode.sql`.
2. Admin: `PUT /api/admin/settings/blog` con `{ "blog_mode": "auto" }` → queda `requested` si aún no hay entitlement.
3. Ops / plataforma: `PUT /api/internal/content/addon` con Bearer `SEO_BLOG_PLATFORM_SERVICE_TOKEN` y `{ "auto_addon_status": "active" }` — **única vía a `active`**.
4. Efectivo pasa a `auto` (cache ~30s; el PUT invalida).

Cuando exista cobro (Stripe / Mercado Pago), el webhook de pago debería llamar al mismo `PUT .../addon` (o `setAutoAddonStatus`).

### Demostración / instancia de prueba con auto activo

```sql
UPDATE site_settings SET blog_mode = 'auto', auto_addon_status = 'active', updated_at = now() WHERE id = 1;
```

---

## Checklist: levantar un cliente nuevo

1. Clonar este repo / nuevo servicio Render.
2. Proyecto Supabase nuevo; aplicar migraciones en `db/migrations/` (incluida `site_settings`).
3. Bucket Storage `blog-images` (público si el front sirve heroes desde ahí).
4. Env mínimas (ver abajo). En **production** `PUBLIC_SITE_URL` es **obligatoria**.
5. Front: apuntar API; consumir `GET /api/site-config` para nav `/blog`.
6. Blog arranca en `off`. Activar `manual` o el flujo auto según el plan del cliente.
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
| `PUBLIC_SITE_URL` | Origen público del **frontend** (sitemap + `public_url` del ingest). Ej. `https://cliente.example.com` |

### Blog / SEO (recomendadas)

| Variable | Default | Descripción |
|---|---|---|
| `SEO_BLOG_PLATFORM_SERVICE_TOKEN` | — | Bearer server-to-server (ingest, status, addon). **Obligatoria** si usás auto. |
| `SEO_BLOG_DEFAULT_AUTHOR` | `BRAND_NAME` o `"Blog"` | Author de posts ingestados |
| `SEO_BLOG_ALLOWED_CLIENT_SLUGS` | (vacío = no validar) | Allowlist coma-separada de `client_slug` |
| `BRAND_NAME` | `"Cleaning Co."` | Marca neutra |
| `SITE_SITEMAP_STATIC_ROUTES` | `[{"path":"/","priority":"1.0"}]` | JSON de rutas estáticas del sitemap. `/blog` y posts se agregan solo si el modo efectivo ≠ `off`. |
| `FRONTEND_URL` | — | Fallback de `PUBLIC_SITE_URL` si esta última falta (no alcanza en prod) |

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

Fuera de auto sin draft-existente: `409 { "success": false, "code": "blog_auto_disabled", "mode": "…" }`.

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
  -d '{"external_id":"demo-1","slug":"hello-world","title":"Hello","body_markdown":"## Intro\nHola","status":"published"}'

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
- `blog_posts` / `blog_sections`: no hay policies en migraciones históricas. Ver SQL defensivo (no ejecutado) en `db/migrations/20260921_blog_tables_rls_defensive.sql`. Verificar a mano en Supabase: RLS ON, sin INSERT/UPDATE/DELETE para `anon`/`authenticated`.

## Ciclo de contrato (§3.7)

```bash
# Requiere PUBLIC_BACKEND_URL, SEO_BLOG_PLATFORM_SERVICE_TOKEN, ADMIN_JWT
node scripts/blog-contract-cycle.mjs
```

## Scripts

```bash
npm run dev    # node src/index.js
npm start
npm test
```
