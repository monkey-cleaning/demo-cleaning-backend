-- LAB447: imágenes de la landing pública editables desde Settings.
-- Una fila por "slot" (clave estable definida en el frontend, ej. 'home.hero').
-- Sin fila = el sitio usa la imagen por defecto empaquetada en el frontend.
-- El bucket público 'site-images' lo crea el backend on-demand (service role).

CREATE TABLE IF NOT EXISTS site_images (
  slot text PRIMARY KEY CHECK (slot ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  url text NOT NULL,
  storage_path text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Backend usa service role (bypassa RLS); anon/authenticated no acceden por PostgREST.
ALTER TABLE site_images ENABLE ROW LEVEL SECURITY;
