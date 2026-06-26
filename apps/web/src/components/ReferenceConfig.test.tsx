import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Tier } from "../lib/types.js";

// Mock the highlighter so we assert on raw code, not token markup.
vi.mock("../lib/hcl-highlight.js", () => ({
  highlightHcl: (code: string) => code,
}));

import { ReferenceConfig } from "./ReferenceConfig.js";

const tier: Tier = {
  name: "budget",
  summary: "Budget",
  nodes: [],
  edges: [],
  delta: [],
  costDrivers: [],
  tradeoffs: [],
};

const TF = 'resource "aws_s3_bucket" "uploads" {\n  bucket = "demo-uploads"\n}';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReferenceConfig", () => {
  it("lazily fetches once, renders code in the red reference-only wrapper, and caches", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ format: "terraform", code: TF }));
    render(<ReferenceConfig tier={tier} />);

    // No fetch until opened.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /show reference setup/i }));

    // Red "reference only" warning banner + the code.
    expect(await screen.findByRole("note")).toHaveTextContent(/reference only/i);
    expect(screen.getByText(/aws_s3_bucket/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Close then re-open — served from cache, no second fetch.
    fireEvent.click(screen.getByRole("button", { name: /hide reference setup/i }));
    fireEvent.click(screen.getByRole("button", { name: /show reference setup/i }));
    expect(screen.getByText(/aws_s3_bucket/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("copies the code to the clipboard", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ format: "terraform", code: TF }));
    render(<ReferenceConfig tier={tier} />);

    fireEvent.click(screen.getByRole("button", { name: /show reference setup/i }));
    await screen.findByText(/aws_s3_bucket/);

    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TF));
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("shows a friendly inline message on a budget-reached error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "daily_budget_reached" }, 503));
    render(<ReferenceConfig tier={tier} />);

    fireEvent.click(screen.getByRole("button", { name: /show reference setup/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/budget/i);
  });
});
