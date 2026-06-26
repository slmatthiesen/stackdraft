import type { FastifyInstance } from "fastify";

const BUILD_VERSION = process.env.BUILD_VERSION ?? "0.1.0-dev";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({
    status: "ok",
    version: BUILD_VERSION,
    uptimeSec: Math.round(process.uptime()),
  }));
}
