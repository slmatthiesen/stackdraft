import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { getConfig, type Config } from "./config.js";
import { healthRoutes } from "./routes/health.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildServer(config: Config = getConfig()): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
      // Never let secrets reach the logs (R15).
      redact: ["req.headers.authorization", "req.headers.cookie", "*.ANTHROPIC_API_KEY"],
    },
    trustProxy: true, // honor CF-Connecting-IP / X-Forwarded-For behind Cloudflare
  });

  await app.register(healthRoutes);

  // Serve the built SPA when present (production single-container path).
  const webDist = resolve(__dirname, config.WEB_DIST);
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      return reply.sendFile("index.html"); // SPA fallback
    });
  }

  return app;
}

async function main(): Promise<void> {
  const config = getConfig();
  const app = await buildServer(config);
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only auto-start when run directly (not when imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
