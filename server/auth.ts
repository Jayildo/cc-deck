import crypto from "node:crypto";

/**
 * Single per-launch bearer token. cc-deck binds to 127.0.0.1, but a token + WS
 * Origin allow-list is the real defense: this app is "a shell behind a token",
 * so we treat every HTTP request and WS upgrade as needing the secret. The
 * token is fetched by the same-origin frontend via GET /api/token; cross-origin
 * pages can trigger that request but cannot read its response (CORS), and the
 * WS Origin check below blocks cross-origin sockets outright.
 */
export const AUTH_TOKEN = crypto.randomBytes(24).toString("hex");

export function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isAllowedOrigin(origin: string | undefined): boolean {
  // Non-browser clients (no Origin header) are allowed. Browsers must come from
  // a loopback origin — but on ANY port, so the Vite dev port can change freely
  // without breaking the WS handshake. The per-launch bearer token is the real
  // gate; a remote origin (e.g. https://evil.com) is rejected here regardless.
  if (!origin) return true;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function tokenFromQuery(url: string | undefined): string | null {
  if (!url) return null;
  const q = url.indexOf("?");
  if (q < 0) return null;
  return new URLSearchParams(url.slice(q + 1)).get("token");
}
