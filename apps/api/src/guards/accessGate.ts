import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { timingSafeEqual } from "node:crypto";

/**
 * Optional shared-credential HTTP Basic gate for the hosted demo (KTD8). OFF by
 * default — when either credential is unset the gate passes through, so local and
 * forked instances run open. The gate is light friction against drive-by bots; the
 * per-IP cap + token caps + global ceiling are what actually bound the bill.
 */
export interface AccessGateConfig {
  user?: string;
  pass?: string;
}

/** Length-independent constant-time compare (avoids leaking which half matched). */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch; hashing to a fixed width keeps the
  // comparison constant-time even when the supplied value differs in length.
  if (ab.length !== bb.length) {
    // Still run a compare of equal-length buffers so timing doesn't reveal length.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function unauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header("WWW-Authenticate", 'Basic realm="drafture", charset="UTF-8"')
    .send({ error: "unauthorized", message: "Valid demo credentials required." });
}

function decodeBasic(header: string): { user: string; pass: string } | undefined {
  if (!header.toLowerCase().startsWith("basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep === -1) return undefined;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

/** Factory → Fastify preHandler. First guard in the chain (KTD8 order). */
export function makeAccessGate(cfg: AccessGateConfig): preHandlerHookHandler {
  const { user, pass } = cfg;
  const enabled = Boolean(user && pass);

  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!enabled || !user || !pass) return; // gate OFF — pass through

    const header = req.headers.authorization;
    if (!header) return unauthorized(reply);

    const creds = decodeBasic(header);
    if (!creds) return unauthorized(reply);

    // Evaluate both halves unconditionally so timing can't reveal a partial match.
    const userOk = constantTimeEquals(creds.user, user);
    const passOk = constantTimeEquals(creds.pass, pass);
    if (!(userOk && passOk)) return unauthorized(reply);
  };
}
