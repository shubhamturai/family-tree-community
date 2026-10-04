import { HttpError, bytesToB64url, b64urlToBytes, safeEqual } from "./util.js";

const TTL_SECONDS = 8 * 60 * 60;
const enc = new TextEncoder();

export const adminConfigured = (env) => typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length > 0;

async function hmacKey(env) {
  const secret = env.SESSION_SECRET || env.ADMIN_PASSWORD;
  return crypto.subtle.importKey("raw", enc.encode("family-graph-session-v1:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Verify the admin password and issue a signed, expiring session token. The password itself is never stored by clients. */
export async function login(env, password) {
  if (!adminConfigured(env)) throw new HttpError(503, "Admin access is not configured on this Worker.");
  if (typeof password !== "string" || !(await safeEqual(password, env.ADMIN_PASSWORD))) throw new HttpError(401, "Incorrect admin password.");
  const now = Math.floor(Date.now() / 1000);
  const body = bytesToB64url(enc.encode(JSON.stringify({ v: 1, iat: now, exp: now + TTL_SECONDS })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body)));
  return { token: body + "." + bytesToB64url(sig), expiresAt: new Date((now + TTL_SECONDS) * 1000).toISOString() };
}

/** True when the request carries a valid, unexpired session token. */
export async function isAdmin(req, env) {
  if (!adminConfigured(env)) return false;
  const m = /^Bearer ([\w-]+)\.([\w-]+)$/.exec(req.headers.get("Authorization") || "");
  if (!m) return false;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), b64urlToBytes(m[2]), enc.encode(m[1]));
    if (!ok) return false;
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(m[1])));
    return claims.v === 1 && Number(claims.exp) > Date.now() / 1000;
  } catch {
    return false;
  }
}

export async function requireAdmin(req, env) {
  if (!(await isAdmin(req, env))) throw new HttpError(401, "Unauthorized");
}
