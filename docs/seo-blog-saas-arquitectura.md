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

**Payload ingest (`POST /api/internal/content/blogs`)**

Obligatorios (si faltan → **400** `{ success: false, error, code: "invalid_payload", fields: [...] }`):

| Campo | Notas |
|---|---|
| `external_id` | string; clave de idempotencia |
| `slug` | string |
| `title` | string |
| `body_markdown` | string; se convierte a `blog_sections` |

Opcionales y defaults del mapper (payload mínimo §3.7 **sin** `meta_description` es válido):

| Campo | Default / cascada |
|---|---|
| `status` | `'draft'` si se omite; si viene, solo `'draft'` \| `'published'` |
| `meta_description` | opcional; alimenta `excerpt` / `seo_description` |
| `excerpt` (columna) | **nunca null**: (a) `meta_description` trim; (b) ~160 chars de `body_markdown` plano (sin markdown), corte en palabra; (c) `title` |
| `seo_description` | igual que `excerpt` |
| `seo_title` | `title` |
| `author` | `SEO_BLOG_DEFAULT_AUTHOR` → `BRAND_NAME` → `"Blog"` |
| `language` | `'es'` |
| `keywords` | `[]` (nunca null) |
| `tag` | primer keyword o `'Blog'` |
| `hero_image_url` | `featured_image_url` o `null` |
| `hero_image_alt` | `title` o `'Blog'` |
| `published_at` | now() si `status=published` y no viene; si no, `null` |
| `seo_score` | `null` |
| `source` | siempre `'seo-blog-platform'` (ignorado si el cliente lo manda) |
| `client_slug` | opcional; si hay allowlist env, debe estar en ella |

Constraint Postgres (`23502` / `23xxx`) → respuesta tipada con `code` (`db_not_null` / `db_constraint` / `conflict`), **no** 500 sin `code`.

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
5. **Addon no activo** (`auto_addon_status` ∈ `inactive` \| `past_due`, o modo efectivo ≠ `auto`) — draft sobre external_id existente despublica; create → 409 `blog_auto_disabled`. Enum de addon: `inactive` \| `requested` \| `active` \| `past_due` (no existe valor `paused`).

---

## 4. Env relevantes

`PUBLIC_SITE_URL` (obligatoria en production), `SEO_BLOG_PLATFORM_SERVICE_TOKEN`, `SEO_BLOG_DEFAULT_AUTHOR`, `SEO_BLOG_ALLOWED_CLIENT_SLUGS`, `SITE_SITEMAP_STATIC_ROUTES`, `BRAND_NAME`, `SUPABASE_*`, `ADMIN_JWT_SECRET`.

---

## 5. Frontend (consumo mínimo)

- `GET /api/site-config` → nav `/blog`.
- Settings: `GET/PUT /api/admin/settings/blog`.
- Admin list: usar `source` para badge “Sincronizado” y ocultar Edit/Delete en modo auto si `source === 'seo-blog-platform'`.
