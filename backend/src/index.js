import { API_VERSION, HttpError, clean } from "./util.js";
import { CORS, json, readJson, secured } from "./http.js";
import { login, requireAdmin, adminConfigured } from "./auth.js";
import { clientKey, count, record } from "./ratelimit.js";
import { sanitizeProposal, sanitizeMeta } from "./validate.js";
import { getGraph, applyAndCommit, gh } from "./github.js";
import { notifyNewRequest } from "./notify.js";
import * as queue from "./requests.js";

const LOGIN_LIMIT = { max: 8, windowSec: 600 };
const SUBMIT_LIMIT = { max: 12, windowSec: 3600 };
const GRAPH_TTL_MS = 15000;
let graphCache = { at: 0, body: "" };

async function liveGraph(env, fresh) {
  if (!fresh && graphCache.body && Date.now() - graphCache.at < GRAPH_TTL_MS) return graphCache.body;
  const body = JSON.stringify((await getGraph(env)).data);
  graphCache = { at: Date.now(), body };
  return body;
}

async function route(req, env, ctx) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "") || "/", method = req.method;

  if (path === "/health") {
    if (!env.DB) return json({ ok: false, service: "family-graph-request-api", error: "D1 binding DB is not configured" }, 503);
    const db = await env.DB.prepare("SELECT 1 AS ok").first();
    return json({ ok: db?.ok === 1, service: "family-graph-request-api", database: "family-tree-community-db", version: API_VERSION, adminConfigured: adminConfigured(env) });
  }

  if (path === "/admin.html" && method === "GET") return secured(await env.ASSETS.fetch(req), { noStore: true });

  if (path === "/data/family.json" && method === "GET") {
    try {
      const body = await liveGraph(env, url.searchParams.has("fresh"));
      return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": url.searchParams.has("fresh") ? "no-store" : "public, max-age=10, stale-while-revalidate=30", ...CORS } });
    } catch (e) {
      // GitHub unavailable or rate-limited: fall back to the copy deployed with the site.
      if (env.ASSETS) return env.ASSETS.fetch(req);
      throw e;
    }
  }

  if (path === "/admin/login" && method === "POST") {
    if (!adminConfigured(env)) throw new HttpError(503, "Admin access is not configured on this Worker.");
    const bucket = "login:" + (await clientKey(req));
    if ((await count(env, bucket, LOGIN_LIMIT.windowSec)) >= LOGIN_LIMIT.max) throw new HttpError(429, "Too many failed attempts. Try again in a few minutes.");
    const b = await readJson(req, 2048);
    try {
      return json({ ok: true, ...(await login(env, b.password)) });
    } catch (e) {
      if (e.status === 401) await record(env, bucket);
      throw e;
    }
  }

  if (path === "/admin/check" && method === "GET") {
    await requireAdmin(req, env);
    return json({ ok: true, authenticated: true });
  }

  if (path === "/admin/github-check" && method === "GET") {
    await requireAdmin(req, env);
    const repo = await gh(env, "/repos/" + env.GITHUB_OWNER + "/" + env.GITHUB_REPO);
    return json({ ok: true, repository: repo.full_name, permissions: { pull: Boolean(repo.permissions?.pull), push: Boolean(repo.permissions?.push), admin: Boolean(repo.permissions?.admin) }, tokenType: repo.permissions?.admin ? "admin-or-owner" : repo.permissions?.push ? "write-access" : "read-only-or-unknown" });
  }

  if (path === "/admin/apply" && method === "POST") {
    await requireAdmin(req, env);
    const b = await readJson(req);
    const proposal = sanitizeProposal(b.proposal);
    const { data, commit } = await applyAndCommit(env, proposal, "Direct administrator family graph update", { dryRun: b.dryRun === true });
    graphCache = { at: 0, body: "" };
    return b.dryRun === true
      ? json({ ok: true, status: "validated", lastUpdated: data.lastUpdated })
      : json({ ok: true, status: "applied", commitSha: commit?.commit?.sha || null, lastUpdated: data.lastUpdated, data });
  }

  if (path === "/requests" && method === "POST") {
    const b = await readJson(req);
    const proposal = sanitizeProposal(b.proposal);
    const meta = sanitizeMeta(b.meta || b.proposal?.meta);
    if (meta) proposal.meta = meta;
    const bucket = "submit:" + (await clientKey(req));
    if ((await count(env, bucket, SUBMIT_LIMIT.windowSec)) >= SUBMIT_LIMIT.max) throw new HttpError(429, "You have sent several requests recently. Please try again later.");
    if ((await queue.pendingCount(env)) >= queue.MAX_PENDING) throw new HttpError(503, "The review queue is full right now. Please try again later.");
    const { id, createdAt } = await queue.createRequest(env, proposal, b.source);
    await record(env, bucket);
    const job = notifyNewRequest(env, { origin: url.origin, proposal });
    if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
    return json({ ok: true, id, status: "pending", createdAt }, 201);
  }

  if (path === "/requests" && method === "GET") {
    await requireAdmin(req, env);
    return json(await queue.listRequests(env, url.searchParams.get("status") || "pending"));
  }

  const status = /^\/requests\/([^/]+)\/status$/.exec(path);
  if (status && method === "GET") return json(await queue.requestStatus(env, decodeURIComponent(status[1])));

  const decision = /^\/requests\/([^/]+)\/(approve|reject)$/.exec(path);
  if (decision && method === "POST") {
    await requireAdmin(req, env);
    const id = decodeURIComponent(decision[1]), action = decision[2];
    const b = await readJson(req);
    const row = await queue.getRequest(env, id);
    if (!row) throw new HttpError(404, "Request not found");
    const note = clean(b.note)?.slice(0, 1000) || "";
    await queue.claim(env, id);
    try {
      if (action === "reject") {
        await queue.finish(env, id, "rejected", note, null);
        return json({ ok: true, status: "rejected" });
      }
      let stored = {};
      try { stored = JSON.parse(row.proposal_json); } catch { /* keep empty */ }
      const proposal = sanitizeProposal({ ...(b.proposal || stored), meta: stored.meta });
      await applyAndCommit(env, proposal, "Apply approved family graph request " + id);
      graphCache = { at: 0, body: "" };
      await queue.finish(env, id, "approved", note, proposal);
      return json({ ok: true, status: "approved", id });
    } catch (e) {
      await queue.release(env, id);
      throw e;
    }
  }

  return env.ASSETS ? secured(await env.ASSETS.fetch(req)) : json({ error: "Not found" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      return await route(req, env, ctx);
    } catch (e) {
      const status = e.status >= 400 && e.status < 600 ? e.status : 500;
      if (status === 500) console.error("Unhandled error:", e);
      return json({ error: status === 500 ? "Internal error. Please try again." : e.message || String(e), status, githubMessage: e.githubMessage || null, githubDocumentation: e.githubUrl || null }, status);
    }
  },
};
