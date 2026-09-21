-- DEFENSIVO — NO EJECUTAR sin revisar el dashboard de Supabase.
-- blog_posts / blog_sections: no hay migraciones de RLS en este repo.
-- Riesgo: si las tablas están con RLS off o con policies de write para
-- `anon` / `authenticated`, cualquiera con la anon key podría INSERT/UPDATE/DELETE
-- posts vía PostgREST (el backend usa service role y bypassa RLS, pero la
-- anon key del frontend o leaks sí verían esas policies).
--
-- Objetivo: habilitar RLS y NO crear policies de write para anon/authenticated.
-- Sin policies = deny all para roles no-service_role.

-- Verificar a mano en Supabase Dashboard:
-- 1) Authentication → Policies (o Table Editor → blog_posts → RLS): ¿RLS ON?
-- 2) Listar policies: ¿hay alguna con INSERT/UPDATE/DELETE para anon o authenticated?
-- 3) Si hay write abierta, deshabilitarla o reemplazar por esta migración tras backup.

ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_sections ENABLE ROW LEVEL SECURITY;

-- Opcional: lectura pública solo de publicados (si el front lee vía anon).
-- Si el front SOLO usa el backend (service role), NO crear policies de SELECT
-- y dejar deny-all para anon.
--
-- Ejemplo SOLO LECTURA de publicados (descomentar si hace falta):
-- CREATE POLICY blog_posts_public_read ON public.blog_posts
--   FOR SELECT TO anon, authenticated
--   USING (status = 'published');
--
-- CREATE POLICY blog_sections_public_read ON public.blog_sections
--   FOR SELECT TO anon, authenticated
--   USING (
--     EXISTS (
--       SELECT 1 FROM public.blog_posts p
--       WHERE p.id = blog_sections.post_id AND p.status = 'published'
--     )
--   );

-- NO crear policies FOR INSERT / UPDATE / DELETE para anon ni authenticated.
-- site_settings ya tiene ENABLE RLS sin policies (migración 20260921).
