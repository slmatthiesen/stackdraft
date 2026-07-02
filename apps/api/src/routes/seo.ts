/**
 * GET /robots.txt + GET /sitemap.xml — the SEO crawl foundation.
 *
 * Without these, crawlers can't discover or index the programmatic gallery + deep-link
 * design pages — the whole SEO wedge (see docs/phase2-gallery.md, positioning notes).
 * robots.txt allows the SPA surface and keeps /api/ private; sitemap.xml lists the stable
 * indexable URLs: the landing page, the gallery, and every PUBLIC design deep link
 * (curated runs + approved community designs). Pending/hidden generations are intentionally
 * absent — they aren't publicly reachable, so advertising them would 404 a crawler.
 *
 * Both are generated server-side so the sitemap stays fresh as the gallery grows, and both
 * are registered before the static SPA plugin so they serve real bytes at their exact paths
 * instead of the index.html SPA fallback.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AppContext } from "../app/context.js";

/** Cap the community-design deep links in the sitemap (all curated runs are included). */
const SITEMAP_DESIGN_LIMIT = 500;

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return c;
    }
  });
}

export async function registerSeoRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/robots.txt", (_req: FastifyRequest, reply: FastifyReply) => handleRobots(ctx, reply));
  app.get("/sitemap.xml", async (_req: FastifyRequest, reply: FastifyReply) =>
    handleSitemap(ctx, reply),
  );
}

function handleRobots(ctx: AppContext, reply: FastifyReply): unknown {
  const origin = ctx.config.SITE_ORIGIN.replace(/\/+$/, "");
  const body = `User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${origin}/sitemap.xml
`;
  return reply.code(200).header("content-type", "text/plain; charset=utf-8").send(body);
}

async function handleSitemap(ctx: AppContext, reply: FastifyReply): Promise<unknown> {
  const origin = ctx.config.SITE_ORIGIN.replace(/\/+$/, "");
  const [curated, approved] = await Promise.all([
    ctx.stores.curated.list(),
    ctx.stores.generations.listApproved(SITEMAP_DESIGN_LIMIT),
  ]);

  const locs = [`${origin}/`, `${origin}/gallery`];
  for (const run of curated) locs.push(`${origin}/design/${encodeURIComponent(run.id)}`);
  for (const gen of approved) locs.push(`${origin}/design/${encodeURIComponent(gen.id)}`);

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    locs.map((loc) => `  <url><loc>${escapeXml(loc)}</loc></url>`).join("\n") +
    `\n</urlset>\n`;

  return reply.code(200).header("content-type", "application/xml; charset=utf-8").send(body);
}
