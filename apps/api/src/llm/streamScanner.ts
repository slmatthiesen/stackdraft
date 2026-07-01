/**
 * Streaming item scanner (fix D, interim) — turns the forced-tool JSON as it decodes
 * into "the model just placed X" events, so the loading UI shows the design BUILDING
 * instead of a bare token ticker.
 *
 * The provider feeds it each `input_json_delta.partial_json` piece; the scanner walks
 * the accumulating JSON with a tiny string-aware state machine and, when an ARRAY-
 * ELEMENT object closes, classifies it by SHAPE (no path tracking needed):
 *   - has `awsService`            → a service node
 *   - has `decision` + `chosen`   → a key decision
 *   - has `from` + `to`+`payload` → an edge
 * Container objects (the root, `baseTier`) open after `:` or at the start — never after
 * `[`/`,` — so they are naturally excluded. Array-element objects don't nest inside one
 * another in this schema (security/alternatives are string arrays), so at most one is
 * ever open, which keeps the machine trivial. Malformed/partial captures parse to null
 * and are dropped — this only ever turns valid-shape into an event, never corrupts.
 */

export interface ScannedItem {
  kind: "node" | "decision" | "edge";
  /** A short human label for the UI (the service name / decision / edge endpoints). */
  label: string;
}

export class StreamItemScanner {
  private depth = 0;
  private inString = false;
  private escape = false;
  /** Last significant (non-whitespace, outside-string) char — decides array elements. */
  private prevSig = "";
  private capturing = false;
  private captureDepth = 0;
  private buf = "";

  /** Feed one streamed JSON piece; returns any items that completed within it. */
  push(chunk: string): ScannedItem[] {
    const out: ScannedItem[] = [];
    for (const ch of chunk) {
      if (this.capturing) this.buf += ch;

      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (ch === "\\") this.escape = true;
        else if (ch === '"') this.inString = false;
        continue;
      }

      switch (ch) {
        case '"':
          this.inString = true;
          this.prevSig = ch;
          break;
        case "{":
          if (!this.capturing && (this.prevSig === "[" || this.prevSig === ",")) {
            this.capturing = true;
            this.captureDepth = this.depth;
            this.buf = "{";
          }
          this.depth++;
          this.prevSig = ch;
          break;
        case "}": {
          this.depth--;
          this.prevSig = ch;
          if (this.capturing && this.depth === this.captureDepth) {
            const item = classify(this.buf);
            this.capturing = false;
            this.buf = "";
            if (item) out.push(item);
          }
          break;
        }
        case "[":
        case "]":
          this.depth += ch === "[" ? 1 : -1;
          this.prevSig = ch;
          break;
        default:
          if (!isWhitespace(ch)) this.prevSig = ch;
      }
    }
    return out;
  }
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

function classify(raw: string): ScannedItem | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.awsService === "string") return { kind: "node", label: obj.awsService };
  if (typeof obj.decision === "string" && "chosen" in obj) return { kind: "decision", label: obj.decision };
  if (typeof obj.from === "string" && typeof obj.to === "string" && "payload" in obj) {
    return { kind: "edge", label: `${obj.from} → ${obj.to}` };
  }
  return null;
}
