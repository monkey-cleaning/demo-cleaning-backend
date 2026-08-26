import { supabase } from "../supabaseClient.js";

const isProduction = () => process.env.NODE_ENV === "production";

const getBaseUrl = (req) => `${req.protocol}://${req.get("host")}`;

const STATIC_ROUTES = [
  { path: "/", priority: "1.0" },
  { path: "/contact-us", priority: "0.9" },
  { path: "/privacy", priority: "0.3" },
  { path: "/blog", priority: "0.6" },
  { path: "/services/general", priority: "0.7" },
  { path: "/services/general/residential", priority: "0.8" },
  { path: "/services/general/commercial", priority: "0.8" },
  { path: "/services/general/offices", priority: "0.8" },
  { path: "/services/specialized", priority: "0.7" },
  { path: "/services/specialized/tile", priority: "0.8" },
  { path: "/services/specialized/carpet", priority: "0.8" },
];

export const getRobotsTxt = (req, res) => {
  if (!isProduction()) {
    res.type("text/plain").send("User-agent: *\nDisallow: /\n");
    return;
  }

  const baseUrl = getBaseUrl(req);

  const lines = [
    "User-agent: *",
    "Disallow: /admin/",
    "Allow: /",
    "",
    `Sitemap: ${baseUrl}/sitemap.xml`,
    "",
  ];

  res.type("text/plain").send(lines.join("\n"));
};

export const getSitemapXml = async (req, res) => {
  if (!isProduction()) {
    res.status(404).end();
    return;
  }

  const baseUrl = getBaseUrl(req);

  let blogUrls = [];
  try {
    const { data, error } = await supabase
      .from("blog_posts")
      .select("slug, updated_at")
      .eq("status", "published");

    if (error) {
      console.error("Supabase error /sitemap.xml blog_posts:", error);
    } else {
      blogUrls = (data || []).map((p) => ({
        path: `/blog/${p.slug}`,
        priority: "0.6",
        lastmod: p.updated_at ? p.updated_at.slice(0, 10) : null,
      }));
    }
  } catch (err) {
    console.error("Server error /sitemap.xml blog_posts:", err);
  }

  const allRoutes = [...STATIC_ROUTES, ...blogUrls];

  const urls = allRoutes
    .map(({ path, priority, lastmod }) => {
      const lastmodTag = lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : "";
      return `  <url>
    <loc>${baseUrl}${path}</loc>
    <priority>${priority}</priority>${lastmodTag}
  </url>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  res.set("Content-Type", "text/xml").send(xml);
};