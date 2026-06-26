import { describe, it, expect, beforeEach } from "vitest";
import { resetConfigCache } from "../config.js";
import { buildServer } from "../server.js";

describe("health route", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
    resetConfigCache();
  });

  it("returns 200 with version + uptime", async () => {
    const app = await buildServer();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBeTruthy();
    expect(typeof body.uptimeSec).toBe("number");
    await app.close();
  });
});
