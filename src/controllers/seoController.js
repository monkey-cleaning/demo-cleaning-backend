import { supabase } from "../supabaseClient.js";
import {
  getPublicSiteUrl,
  getSitemapStaticRoutes,
} from "../config/site.js";
import { getEffectiveBlogMode } from "../services/blogModeService.js";

const isProduction = () => process.env.NODE_ENV === "production";

export const getRobotsTxt = (req, res) => {
  if (!isProduction()) {
    res.type("text/plain").send("User-agent: *\nDisallow: /\n");
    return;
  }

  const baseUrl = getPublicSiteUrl();

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

  const baseUrl = getPublicSiteUrl();
  const staticRoutes = getSitemapStaticRoutes();

  const effectiveMode = await getEffectiveBlogMode();
  const blogEnabled = effectiveMode !== "off";

  const routes = [...staticRoutes];
  if (blogEnabled && !routes.some((r) => r.path === "/blog")) {
    routes.push({ path: "/blog", priority: "0.6" });
  }

  let blogUrls = [];
  if (blogEnabled) {
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
  }

  const allRoutes = [...routes, ...blogUrls];

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
