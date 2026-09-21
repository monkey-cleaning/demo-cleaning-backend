-- site_settings: config de instancia (blog mode + addon auto).
-- Una sola fila por proyecto (singleton id = 1).
-- Default blog_mode = 'off' (blog desactivado hasta que el cliente lo active).

CREATE TABLE IF NOT EXISTS site_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  blog_mode text NOT NULL DEFAULT 'off'
    CHECK (blog_mode IN ('off', 'manual', 'auto')),
  auto_addon_status text NOT NULL DEFAULT 'inactive'
    CHECK (auto_addon_status IN ('inactive', 'requested', 'active', 'past_due')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO site_settings (id, blog_mode, auto_addon_status)
VALUES (1, 'off', 'inactive')
ON CONFLICT (id) DO NOTHING;

-- Backend usa service role (bypassa RLS). Sin policies = clientes anon/authenticated
-- no pueden leer ni escribir esta tabla vía PostgREST.
ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;

-- Demo / instancia de prueba con ingest auto activo:
-- UPDATE site_settings SET blog_mode = 'auto', auto_addon_status = 'active', updated_at = now() WHERE id = 1;
