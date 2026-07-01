import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { LoadingDraft } from "./LoadingDraft.js";

describe("LoadingDraft", () => {
  it("shows the real phase label and a token heartbeat when streaming (fix D)", () => {
    render(<LoadingDraft phase="generating" chars={800} />);
    expect(screen.getByText(/Designing the architecture/i)).toBeInTheDocument();
    // ~4 chars/token → 800 chars ≈ 200 tokens.
    expect(screen.getByText(/~200 tokens/)).toBeInTheDocument();
  });

  it("maps each server phase step to a human label", () => {
    const { rerender } = render(<LoadingDraft phase="preparing" chars={0} />);
    expect(screen.getByText(/Reviewing your requirements/i)).toBeInTheDocument();
    rerender(<LoadingDraft phase="costing" chars={0} />);
    expect(screen.getByText(/Sizing and costing the tier/i)).toBeInTheDocument();
    // No token ticker until output starts flowing.
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
  });

  it("falls back to the drafting animation with no stream props", () => {
    render(<LoadingDraft />);
    expect(screen.getByRole("status")).toHaveTextContent(/drafting your architecture/i);
  });

  it("renders the live build list of streamed items (fix D)", () => {
    render(
      <LoadingDraft
        phase="generating"
        chars={0}
        items={[
          { kind: "decision", label: "Compute model" },
          { kind: "node", label: "API Gateway" },
          { kind: "node", label: "DynamoDB" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: /design taking shape/i });
    expect(list).toBeInTheDocument();
    expect(screen.getByText("API Gateway")).toBeInTheDocument();
    expect(screen.getByText("DynamoDB")).toBeInTheDocument();
    expect(screen.getByText("Compute model")).toBeInTheDocument();
  });
});
