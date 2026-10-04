import { HttpError } from "./util.js";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Allow-Private-Network": "true",
  Vary: "Origin",
};

export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extra } });

export const MAX_BODY_BYTES = 100 * 1024;

/** Parse a JSON request body, refusing anything larger than `max` bytes. */
export async function readJson(req, max = MAX_BODY_BYTES) {
  const declared = Number(req.headers.get("Content-Length") || 0);
  if (declared > max) throw new HttpError(413, "Request body is too large.");
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "Request body is too large.");
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw 0;
    return body;
  } catch {
    throw new HttpError(400, "Invalid JSON body.");
  }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://api.github.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Add security headers to HTML responses served by the Worker. */
export function secured(res, { noStore = false } = {}) {
  const type = res.headers.get("Content-Type") || "";
  const h = new Headers(res.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  if (type.includes("text/html")) {
    h.set("Content-Security-Policy", CSP);
    h.set("X-Frame-Options", "DENY");
  }
  if (noStore) {
    h.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    h.set("Pragma", "no-cache");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
