import { HttpError, clean } from "./util.js";

const need = (env) => {
  if (!env.DB) throw new HttpError(503, "D1 binding DB is not configured on this Worker.");
  return env.DB;
};
export const MAX_PENDING = 500;

export async function pendingCount(env) {
  const row = await need(env).prepare("SELECT COUNT(*) AS n FROM requests WHERE status='pending'").first();
  return Number(row?.n) || 0;
}

export async function createRequest(env, proposal, source) {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await need(env).prepare("INSERT INTO requests(id,status,title,proposal_json,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .bind(id, "pending", "Family graph batch update", JSON.stringify(proposal), clean(source) || "public-web", now, now).run();
  return { id, createdAt: now };
}

export async function listRequests(env, status) {
  const db = need(env);
  const rows = await db.prepare("SELECT id,status,title,proposal_json,source,created_at,updated_at,note FROM requests WHERE status=? ORDER BY created_at ASC LIMIT 100").bind(status).all();
  const tot = await db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status=?").bind(status).first();
  const list = (rows.results || []).map((r) => {
    let proposal;
    try { proposal = JSON.parse(r.proposal_json); } catch { proposal = { operation: "INVALID_PROPOSAL", payload: {}, parseError: "Stored proposal JSON is invalid." }; }
    return { ...r, createdAt: r.created_at, updatedAt: r.updated_at, proposal };
  });
  return { total: Number(tot?.n) || list.length, requests: list };
}

/** What a contributor may learn about their own request: its status and the reviewer's note — never the proposal. */
export async function requestStatus(env, id) {
  const r = await need(env).prepare("SELECT id,status,note,created_at,updated_at FROM requests WHERE id=?").bind(id).first();
  if (!r) throw new HttpError(404, "Request not found");
  return { id: r.id, status: r.status === "processing" ? "pending" : r.status, note: r.note || "", createdAt: r.created_at, updatedAt: r.updated_at };
}

export const getRequest = (env, id) => need(env).prepare("SELECT * FROM requests WHERE id=?").bind(id).first();

/** Atomically move a pending request to "processing" so two reviewers (or a double click) cannot apply it twice. */
export async function claim(env, id) {
  const r = await need(env).prepare("UPDATE requests SET status='processing',updated_at=? WHERE id=? AND status='pending'").bind(new Date().toISOString(), id).run();
  if (r?.meta?.changes > 0) return true;
  const cur = await need(env).prepare("SELECT status FROM requests WHERE id=?").bind(id).first();
  throw new HttpError(409, "Request is already " + (cur?.status === "processing" ? "being processed" : cur?.status || "gone"));
}
export const release = (env, id) =>
  need(env).prepare("UPDATE requests SET status='pending',updated_at=? WHERE id=? AND status='processing'").bind(new Date().toISOString(), id).run().catch(() => {});
export const finish = (env, id, status, note, proposal) =>
  need(env).prepare("UPDATE requests SET status=?,note=?,proposal_json=COALESCE(?,proposal_json),updated_at=? WHERE id=?")
    .bind(status, note, proposal ? JSON.stringify(proposal) : null, new Date().toISOString(), id).run();
