import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("config", () => {
  it("loads with forker-safe defaults", () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv);
    expect(c.LLM_MODEL).toBe("claude-sonnet-4-6");
    expect(c.DAILY_SPEND_CEILING_USD).toBe(5);
    expect(c.DEFAULT_REGION).toBe("us-east-1");
    expect(c.RESEARCH_ON_MISS).toBe(false);
  });

  it("fails fast with a clear error when ANTHROPIC_API_KEY is missing", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("parses boolish RESEARCH_ON_MISS", () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: "k", RESEARCH_ON_MISS: "true" } as NodeJS.ProcessEnv);
    expect(c.RESEARCH_ON_MISS).toBe(true);
  });
});
