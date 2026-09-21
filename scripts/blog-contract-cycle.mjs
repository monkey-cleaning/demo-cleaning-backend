#!/usr/bin/env node
/**
 * Ciclo de contrato §3.7 — blog modes + ingest.
 *
 * Uso:
 *   node scripts/blog-contract-cycle.mjs
 *
 * Requiere env (ver missing list si skipped):
 *   PUBLIC_BACKEND_URL     — base del backend, ej. http://localhost:4000
 *   SEO_BLOG_PLATFORM_SERVICE_TOKEN
 *   ADMIN_JWT              — Bearer de un admin (login previo)
 *   PUBLIC_SITE_URL        — opcional; solo se chequea en respuestas de ingest
 *
 * Exit 0 si todos los pasos aplicables pasan; 1 si alguno falla;
 * 2 si skipped por falta de env.
 */

import "dotenv/config";

const BASE = (process.env.PUBLIC_BACKEND_URL || process.env.BACKEND_URL || "")
  .replace(/\/$/, "");
const TOKEN = process.env.SEO_BLOG_PLATFORM_SERVICE_TOKEN || "";
const ADMIN_JWT = process.env.ADMIN_JWT || "";

const required = [
  ["PUBLIC_BACKEND_URL (or BACKEND_URL)", BASE],
  ["SEO_BLOG_PLATFORM_SERVICE_TOKEN", TOKEN],
  ["ADMIN_JWT", ADMIN_JWT],
];

const missing = required.filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.log("SKIPPED — faltan variables de entorno:");
  for (const k of missing) console.log(`  - ${k}`);
  console.log(`
Para correr contra staging, seteá por ejemplo:

  PUBLIC_BACKEND_URL=https://<tu-backend>.onrender.com
  SEO_BLOG_PLATFORM_SERVICE_TOKEN=<mismo token del .env del backend>
  ADMIN_JWT=<token de POST /api/admin/auth/login>

Opcional: PUBLIC_SITE_URL=https://<frontend>

Luego: node scripts/blog-contract-cycle.mjs
`);
  process.exit(2);
}

const results = [];

function record(step, status, detail = "") {
  results.push({ step, status, detail });
  const mark = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
  console.log(`[${mark}] ${step}${detail ? ` — ${detail}` : ""}`);
}

async function req(method, path, { token, admin, body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${TOKEN}`;
  if (admin) headers.Authorization = `Bearer ${ADMIN_JWT}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

async function setBlogMode(mode) {
  return req("PUT", "/api/admin/settings/blog", {
    admin: true,
    body: { blog_mode: mode },
  });
}

async function setAddon(status) {
  return req("PUT", "/api/internal/content/addon", {
    token: true,
    body: { auto_addon_status: status },
  });
}

function assertAutoDisabled(res) {
  return (
    res.status === 409 &&
    res.json?.code === "blog_auto_disabled" &&
    res.json?.success === false &&
    typeof res.json?.error === "string" &&
    typeof res.json?.mode === "string"
  );
}

const EXT = `cycle-${Date.now()}`;
const SLUG = `cycle-test-${Date.now()}`;

async function main() {
  // Restore helpers
  const cleanup = async () => {
    await setAddon("inactive").catch(() => {});
    await setBlogMode("off").catch(() => {});
  };

  try {
    // ── 1. off ────────────────────────────────────────────────────────────
    {
      const put = await setBlogMode("off");
      if (put.status !== 200 || put.json?.effective_mode !== "off") {
        record("1.off set mode", "fail", JSON.stringify(put.json));
      } else {
        record("1.off set mode", "pass");
      }

      const site = await req("GET", "/api/site-config");
      if (
        site.status === 200 &&
        site.json?.blogEnabled === false &&
        site.json?.blogMode === "off"
      ) {
        record("1.off site-config", "pass");
      } else {
        record("1.off site-config", "fail", JSON.stringify(site.json));
      }

      const pub = await req("GET", "/api/blogs");
      if (pub.status === 404) record("1.off public blogs 404", "pass");
      else record("1.off public blogs 404", "fail", `status=${pub.status}`);

      const adm = await req("GET", "/api/admin/blogs", { admin: true });
      if (adm.status === 403 && adm.json?.code === "blog_disabled") {
        record("1.off admin blogs 403 blog_disabled", "pass");
      } else {
        record(
          "1.off admin blogs 403 blog_disabled",
          "fail",
          `status=${adm.status} ${JSON.stringify(adm.json)}`,
        );
      }
    }

    // ── 2. manual ─────────────────────────────────────────────────────────
    {
      const put = await setBlogMode("manual");
      if (put.status !== 200 || put.json?.effective_mode !== "manual") {
        record("2.manual set mode", "fail", JSON.stringify(put.json));
      } else {
        record("2.manual set mode", "pass");
      }

      await setAddon("inactive");

      const create = await req("POST", "/api/internal/content/blogs", {
        token: true,
        body: {
          external_id: EXT,
          slug: SLUG,
          title: "Cycle Test",
          body_markdown: "## Intro\nhello",
          status: "published",
        },
      });
      if (assertAutoDisabled(create)) {
        record("2.manual ingest publish → 409 blog_auto_disabled", "pass");
      } else {
        record(
          "2.manual ingest publish → 409 blog_auto_disabled",
          "fail",
          `status=${create.status} ${JSON.stringify(create.json)}`,
        );
      }

      const adm = await req("GET", "/api/admin/blogs", { admin: true });
      if (adm.status === 200 && Array.isArray(adm.json)) {
        const hasSourceKey =
          adm.json.length === 0 ||
          adm.json.every((p) => "source" in p);
        record(
          "2.manual admin list includes source",
          hasSourceKey ? "pass" : "fail",
        );
      } else {
        record("2.manual admin list includes source", "fail", `status=${adm.status}`);
      }
    }

    // ── 3. auto sin addon ─────────────────────────────────────────────────
    {
      await setAddon("inactive");
      const put = await setBlogMode("auto");
      const snapOk =
        put.status === 200 &&
        put.json?.blog_mode === "auto" &&
        put.json?.effective_mode === "manual" &&
        put.json?.entitled === false &&
        put.json?.auto_addon_status === "requested";
      record(
        "3.auto-without-addon effective=manual requested",
        snapOk ? "pass" : "fail",
        JSON.stringify(put.json),
      );

      const st = await req("GET", "/api/internal/content/status", {
        token: true,
      });
      const statusOk =
        st.status === 200 &&
        st.json?.mode === "manual" &&
        st.json?.entitled === false &&
        st.json?.auto_addon_status === "requested";
      record(
        "3.status matches site-config effective",
        statusOk ? "pass" : "fail",
        JSON.stringify(st.json),
      );

      const site = await req("GET", "/api/site-config");
      const aligned =
        site.json?.blogMode === st.json?.mode && site.json?.blogEnabled === true;
      record(
        "3.site-config aligned with status.mode",
        aligned ? "pass" : "fail",
        `site=${JSON.stringify(site.json)} status=${JSON.stringify(st.json)}`,
      );
    }

    // ── 4. addon active ───────────────────────────────────────────────────
    {
      const add = await setAddon("active");
      if (
        add.status === 200 &&
        add.json?.auto_addon_status === "active" &&
        add.json?.effective_mode === "auto"
      ) {
        record("4.addon active → effective auto", "pass");
      } else {
        record(
          "4.addon active → effective auto",
          "fail",
          JSON.stringify(add.json),
        );
      }

      const create = await req("POST", "/api/internal/content/blogs", {
        token: true,
        body: {
          external_id: EXT,
          slug: SLUG,
          title: "Cycle Test",
          body_markdown: "## Intro\nhello",
          status: "published",
        },
      });
      if (
        create.status === 201 &&
        create.json?.success === true &&
        create.json?.action === "created" &&
        create.json?.slug === SLUG
      ) {
        record("4.ingest create published", "pass");
      } else {
        record(
          "4.ingest create published",
          "fail",
          `status=${create.status} ${JSON.stringify(create.json)}`,
        );
      }

      const upd = await req("POST", "/api/internal/content/blogs", {
        token: true,
        body: {
          external_id: EXT,
          slug: SLUG,
          title: "Cycle Test Updated",
          body_markdown: "## Intro\nhello2",
          status: "published",
        },
      });
      if (upd.status === 200 && upd.json?.action === "updated") {
        record("4.ingest update published", "pass");
      } else {
        record(
          "4.ingest update published",
          "fail",
          `status=${upd.status} ${JSON.stringify(upd.json)}`,
        );
      }

      // source forced
      const adm = await req("GET", "/api/admin/blogs", { admin: true });
      const post = Array.isArray(adm.json)
        ? adm.json.find((p) => p.external_id === EXT || p.slug === SLUG)
        : null;
      if (post?.source === "seo-blog-platform") {
        record("4.post.source === seo-blog-platform", "pass");
      } else {
        record(
          "4.post.source === seo-blog-platform",
          "fail",
          JSON.stringify(post),
        );
      }
    }

    // ── 5. paused ─────────────────────────────────────────────────────────
    {
      await setAddon("inactive");
      // blog_mode still auto → effective manual
      const st = await req("GET", "/api/internal/content/status", {
        token: true,
      });
      if (st.json?.mode === "manual" && st.json?.entitled === false) {
        record("5.paused effective=manual", "pass");
      } else {
        record("5.paused effective=manual", "fail", JSON.stringify(st.json));
      }

      const draft = await req("POST", "/api/internal/content/blogs", {
        token: true,
        body: {
          external_id: EXT,
          slug: SLUG,
          title: "Cycle Test",
          body_markdown: "## Intro\nx",
          status: "draft",
        },
      });
      if (draft.status === 200 && draft.json?.action === "updated") {
        record("5.draft unpublish existing → updated", "pass");
      } else {
        record(
          "5.draft unpublish existing → updated",
          "fail",
          `status=${draft.status} ${JSON.stringify(draft.json)}`,
        );
      }

      const create = await req("POST", "/api/internal/content/blogs", {
        token: true,
        body: {
          external_id: `${EXT}-new`,
          slug: `${SLUG}-new`,
          title: "Should Fail",
          body_markdown: "## No",
          status: "published",
        },
      });
      if (assertAutoDisabled(create)) {
        record("5.create while paused → 409 blog_auto_disabled", "pass");
      } else {
        record(
          "5.create while paused → 409 blog_auto_disabled",
          "fail",
          `status=${create.status} ${JSON.stringify(create.json)}`,
        );
      }
    }
  } finally {
    await cleanup();
    console.log("\n(cleanup: addon=inactive, blog_mode=off)");
  }

  const failed = results.filter((r) => r.status === "fail");
  const passed = results.filter((r) => r.status === "pass");
  console.log(`\nSummary: ${passed.length} pass, ${failed.length} fail`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
