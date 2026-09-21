# Arquitectura SEO Blog SaaS (plantilla white-label)

> Documento de trabajo para este repo (plantilla por cliente).  
> Si el PDF original se adjunta después, reemplazar/ampliar este archivo.  
> **§3 Contrato HTTP** abajo es la fuente de verdad operativa para backend + seo-blog-platform + frontend.

---

## 1. Modelo

- Una instancia backend + Supabase por cliente (sitio white-label).
- Modo de blog en DB (`site_settings`), no en env: `off` | `manual` | `auto`.
- Addon auto: `auto_addon_status` ∈ `inactive` | `requested` | `active` | `past_due`.
- Modo **efectivo**: si `blog_mode = auto` y entitlement no activo → cae a `manual`.
- Entitlement hoy: `auto_addon_status === 'active'` (`hasAutoBlogEntitlement`). Cobro (Stripe/MP) se enchufa vía `PUT /api/internal/content/addon`.

---

## 2. Tablas

### `site_settings` (singleton `id = 1`)

| Columna | Default |
|---|---|
| `blog_mode` | `'off'` |
| `auto_addon_status` | `'inactive'` |
| `updated_at` | now() |

RLS enabled, sin policies (solo service role).

### `blog_posts` / `blog_sections`

Campos relevantes de post: `slug`, `title`, `status`, `source` (`'seo-blog-platform'` \| `'admin'` \| `null`), `external_id`, SEO, etc.

---

## 3. Contrato HTTP

### 3.1 Público

| Método | Ruta | Auth | Notas |
|---|---|---|---|
| GET | `/api/site-config` | no | `{ blogEnabled, blogMode }` — `blogMode` = **efectivo** |
| GET | `/api/blogs` | no | Si efectivo `off` → **404** |
| GET | `/api/blogs/:slug` | no | Si efectivo `off` → **404** |
| GET | `/robots.txt`, `/sitemap.xml` | no | Sitemap: `/blog` + posts solo si efectivo ≠ `off`. Base = `PUBLIC_SITE_URL` |

### 3.2 Admin (JWT `blog-admin`)

| Método | Ruta | Notas |
|---|---|---|
| GET/PUT | `/api/admin/settings/blog` | PUT solo `blog_mode`. Respuesta: `blog_mode`, `effective_mode`, `auto_addon_status`, `entitled` |
| GET | `/api/admin/blogs` | Incluye **`source`** en cada post. Si `off` → **403** `{ error, code: "blog_disabled" }` |
| GET | `/api/admin/blogs/:id` | `{ post, sections }` — `post.source` presente. Misma gate `off` |
| POST/PUT/DELETE | `/api/admin/blogs...` | `off` → 403 `blog_disabled`. En efectivo `auto`, no editar/borrar `source = seo-blog-platform` → 403 `blog_managed_by_platform`. Creates manuales: `source: 'admin'` |

### 3.3 Interno (Bearer `SEO_BLOG_PLATFORM_SERVICE_TOKEN`)

| Método | Ruta | Notas |
|---|---|---|
| GET | `/api/internal/content/status` | Exacto: `{ mode, entitled, auto_addon_status }` — `mode` = **efectivo** |
| PUT | `/api/internal/content/addon` | Body `{ auto_addon_status }`. Única vía a `active` |
| POST | `/api/internal/content/blogs` | Ingest. Fuerza `source = 'seo-blog-platform'` |

**Ingest fuera de efectivo `auto`:**

- Solo permitido: `status: "draft"` sobre `external_id` **existente** (despublicar) → `action: "updated"`.
- Crear o publicar → **409**:

```json
{
  "success": false,
  "error": "Blog auto mode is disabled",
  "code": "blog_auto_disabled",
  "mode": "<modo efectivo actual>"
}
```

**Ingest éxito:**

```json
{
  "success": true,
  "post_id": "<id>",
  "slug": "...",
  "public_url": "{PUBLIC_SITE_URL}/blog/{slug}",
  "action": "created" | "updated"
}
```

Idempotencia por `external_id`. `status: "draft"` sobre publicado despublica.

### 3.7 Ciclo de validación

1. **off** — público 404; admin blogs 403 `blog_disabled`; site-config `blogEnabled: false`.
2. **manual** — admin CRUD OK; ingest publish/create → 409 `blog_auto_disabled`; draft+existing OK.
3. **auto sin addon** — efectivo `manual`; status `mode: "manual"`, `entitled: false`, `auto_addon_status: "requested"` (si eligieron auto).
4. **addon active** — efectivo `auto`; ingest create/update OK.
5. **paused** (addon inactive/past_due o modo no auto) — draft sobre external_id existente despublica; create → 409 `blog_auto_disabled`.

---

## 4. Env relevantes

`PUBLIC_SITE_URL` (obligatoria en production), `SEO_BLOG_PLATFORM_SERVICE_TOKEN`, `SEO_BLOG_DEFAULT_AUTHOR`, `SEO_BLOG_ALLOWED_CLIENT_SLUGS`, `SITE_SITEMAP_STATIC_ROUTES`, `BRAND_NAME`, `SUPABASE_*`, `ADMIN_JWT_SECRET`.

---

## 5. Frontend (consumo mínimo)

- `GET /api/site-config` → nav `/blog`.
- Settings: `GET/PUT /api/admin/settings/blog`.
- Admin list: usar `source` para badge “Sincronizado” y ocultar Edit/Delete en modo auto si `source === 'seo-blog-platform'`.
