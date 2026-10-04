import { sha256Hex } from "./util.js";

/** Anonymous but stable client key: a hash of the connecting IP (never stored raw). */
export async function clientKey(req) {
  return (await sha256Hex("family-graph:" + (req.headers.get("CF-Connecting-IP") || "unknown"))).slice(0, 24);
}

/** Rate limiting is best-effort: if the table is unavailable (e.g. mid-migration) requests are allowed rather than blocked. */
export async function count(env, bucket, windowSec) {
  if (!env.DB) return 0;
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE bucket=? AND ts>?").bind(bucket, Date.now() - windowSec * 1000).first();
    return Number(row?.n) || 0;
  } catch (e) {
    console.error("rate limit lookup failed:", e);
    return 0;
  }
}

export async function record(env, bucket) {
  if (!env.DB) return;
  try {
    await env.DB.prepare("INSERT INTO rate_limits(bucket,ts) VALUES(?,?)").bind(bucket, Date.now()).run();
    if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM rate_limits WHERE ts<?").bind(Date.now() - 24 * 3600 * 1000).run();
  } catch (e) {
    console.error("rate limit write failed:", e);
  }
}
