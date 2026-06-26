import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlossaryText } from "./GlossaryText.js";

describe("GlossaryText", () => {
  it("wraps a known term in an <abbr> carrying its definition", () => {
    render(<GlossaryText>Add a DLQ to the queue</GlossaryText>);
    const abbr = screen.getByText("DLQ");
    expect(abbr.tagName).toBe("ABBR");
    expect(abbr.getAttribute("data-tip")?.toLowerCase()).toContain("dead-letter");
  });

  it("leaves text with no known terms as a single plain run", () => {
    const { container } = render(<GlossaryText>just some plain words</GlossaryText>);
    expect(container.querySelector("abbr")).toBeNull();
    expect(container).toHaveTextContent("just some plain words");
  });

  it("does not match a term inside a larger word (IAM ∉ Miami)", () => {
    const { container } = render(<GlossaryText>We met in Miami</GlossaryText>);
    expect(container.querySelector("abbr")).toBeNull();
  });

  it("prefers the longest term (Multi-AZ over a bare match)", () => {
    render(<GlossaryText>Adds Multi-AZ failover</GlossaryText>);
    expect(screen.getByText("Multi-AZ").tagName).toBe("ABBR");
  });
});
