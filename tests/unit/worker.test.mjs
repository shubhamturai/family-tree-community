import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../../backend/worker.js";
import { baseEnv, call, installGithub, sampleGraph } from "../helpers/fakes.mjs";

let env, gh, restore;
const batch = (changes, extra = {}) => ({ operation: "BATCH_UPDATE", payload: { changes, ...extra } });
const addPerson = (person) => ({ type: "ADD_PERSON", payload: { person } });
const loginToken = async (e = env) => (await (await call(worker, e, "/admin/login", { method: "POST", body: { password: "correct-horse-battery" } })).json()).token;
const submit = async (proposal, opts = {}) => call(worker, env, "/requests", { method: "POST", body: { proposal, source: "public-web", ...opts.extra }, ip: opts.ip });

beforeEach(() => { env = baseEnv(); gh = { graph: sampleGraph() }; restore = installGithub(gh); });
afterEach(() => restore());

describe("admin sessions", () => {
  test("login rejects a wrong password and accepts the right one", async () => {
    assert.equal((await call(worker, env, "/admin/login", { method: "POST", body: { password: "nope" } })).status, 401);
    const ok = await call(worker, env, "/admin/login", { method: "POST", body: { password: "correct-horse-battery" } });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.match(j.token, /^[\w-]+\.[\w-]+$/);
    assert.ok(new Date(j.expiresAt) > new Date());
  });
  test("a token opens admin routes; the raw password and tampered tokens do not", async () => {
    const token = await loginToken();
    assert.equal((await call(worker, env, "/admin/check", { token })).status, 200);
    assert.equal((await call(worker, env, "/admin/check", { token: "correct-horse-battery" })).status, 401);
    assert.equal((await call(worker, env, "/admin/check", { token: token.slice(0, -2) + "xx" })).status, 401);
    assert.equal((await call(worker, env, "/admin/check")).status, 401);
    assert.equal((await call(worker, env, "/requests", { token: "undefined" })).status, 401);
  });
  test("tokens expire", async () => {
    const real = Date.now;
    const token = await loginToken();
    Date.now = () => real() + 9 * 3600 * 1000;
    try { assert.equal((await call(worker, env, "/admin/check", { token })).status, 401); } finally { Date.now = real; }
  });
  test("a token signed for another password is rejected (rotating the password logs everyone out)", async () => {
    const token = await loginToken();
    assert.equal((await call(worker, { ...env, ADMIN_PASSWORD: "a-different-long-password" }, "/admin/check", { token })).status, 401);
  });
  test("fails closed when ADMIN_PASSWORD is not configured", async () => {
    const bare = baseEnv({ ADMIN_PASSWORD: undefined });
    assert.equal((await call(worker, bare, "/admin/login", { method: "POST", body: { password: "undefined" } })).status, 503);
    for (const t of ["undefined", ""]) assert.equal((await call(worker, bare, "/admin/check", { token: t })).status, 401);
    assert.equal((await call(worker, bare, "/requests")).status, 401);
  });
  test("repeated failed logins are rate limited", async () => {
    for (let i = 0; i < 8; i++) assert.equal((await call(worker, env, "/admin/login", { method: "POST", body: { password: "bad" + i } })).status, 401);
    assert.equal((await call(worker, env, "/admin/login", { method: "POST", body: { password: "correct-horse-battery" } })).status, 429);
    assert.equal((await call(worker, env, "/admin/login", { method: "POST", body: { password: "correct-horse-battery" }, ip: "9.9.9.9" })).status, 200);
  });
});

describe("public submissions", () => {
  test("accepts a valid batch, stores a sanitised copy and contributor details", async () => {
    const r = await submit(batch([addPerson({ displayName: "  Meera Rao ", gender: "female", bogus: "x", photoDataUrl: "data:image/png;base64,AAAA" })]), { extra: { meta: { name: "Priya", message: "Found in the family Bible" } } });
    assert.equal(r.status, 201);
    const { id } = await r.json();
    const stored = JSON.parse(env.DB.requests.get(id).proposal_json);
    assert.deepEqual(stored.payload.changes[0].payload.person, { displayName: "Meera Rao", gender: "female" });
    assert.deepEqual(stored.meta, { name: "Priya", message: "Found in the family Bible" });
  });
  for (const [label, proposal] of [
    ["not a batch", { operation: "ADD_PERSON", payload: {} }],
    ["no changes", batch([])],
    ["unknown change type", batch([{ type: "DROP_TABLE", payload: {} }])],
    ["bad person id", batch([{ type: "DELETE_PERSON", payload: { personId: "; DROP" } }])],
    ["bad date", batch([addPerson({ displayName: "A", dateOfBirth: "31/02/2000" })])],
    ["death before birth", batch([addPerson({ displayName: "A", dateOfBirth: "2000-01-02", dateOfDeath: "1999-01-01" })])],
    ["overlong text", batch([addPerson({ displayName: "x".repeat(500) })])],
    ["nameless person", batch([addPerson({ gender: "male" })])],
    ["self parent", batch([{ type: "ADD_PARENT_CHILD", payload: { parentId: "P000001", childId: "P000001" } }])],
    ["too many changes", batch(Array.from({ length: 101 }, (_, i) => addPerson({ displayName: "P" + i })))],
  ]) test("rejects: " + label, async () => { assert.equal((await submit(proposal)).status, 400); assert.equal(env.DB.requests.size, 0); });
  test("rejects oversized bodies and invalid JSON", async () => {
    assert.equal((await call(worker, env, "/requests", { method: "POST", body: "{" })).status, 400);
    assert.equal((await call(worker, env, "/requests", { method: "POST", body: JSON.stringify({ proposal: batch([addPerson({ displayName: "A", notes: "x".repeat(4000) })]), pad: "y".repeat(200000) }) })).status, 413);
  });
  test("a client is rate limited after a burst of submissions", async () => {
    for (let i = 0; i < 12; i++) assert.equal((await submit(batch([addPerson({ displayName: "P" + i })]))).status, 201);
    assert.equal((await submit(batch([addPerson({ displayName: "one more" })]))).status, 429);
    assert.equal((await submit(batch([addPerson({ displayName: "other client" })]), { ip: "8.8.8.8" })).status, 201);
  });
  test("contributors can follow a request without seeing its contents", async () => {
    const { id } = await (await submit(batch([addPerson({ displayName: "Meera" })]))).json();
    let s = await (await call(worker, env, "/requests/" + id + "/status")).json();
    assert.deepEqual(Object.keys(s).sort(), ["createdAt", "id", "note", "status", "updatedAt"]);
    assert.equal(s.status, "pending");
    const token = await loginToken();
    await call(worker, env, "/requests/" + id + "/reject", { method: "POST", token, body: { note: "Please add a date of birth" } });
    s = await (await call(worker, env, "/requests/" + id + "/status")).json();
    assert.equal(s.status, "rejected");
    assert.equal(s.note, "Please add a date of birth");
    assert.equal((await call(worker, env, "/requests/nope/status")).status, 404);
  });
});

describe("notifications", () => {
  const hooks = [];
  const realFetch = () => globalThis.fetch;
  test("a new request pings the configured webhook without delaying or breaking the submission", async () => {
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, opt) => { if (String(url).startsWith("https://hooks.test")) { hooks.push({ url: String(url), body: opt.body, type: opt.headers["Content-Type"] }); return new Response("ok"); } return inner(url, opt); };
    try {
      const jobs = [], ctx = { waitUntil: (p) => jobs.push(p) };
      const e = { ...env, NOTIFY_WEBHOOK_URL: "https://hooks.test/abc" };
      const r = await call(worker, e, "/requests", { method: "POST", ctx, body: { proposal: batch([addPerson({ displayName: "Meera" })]), meta: { name: "Priya", message: "Family Bible" } } });
      assert.equal(r.status, 201);
      await Promise.all(jobs);
      assert.equal(hooks.length, 1);
      const sent = JSON.parse(hooks[0].body);
      assert.match(sent.text, /1 change from Priya/); assert.match(sent.text, /Family Bible/); assert.match(sent.text, /\/admin\.html/);
      assert.equal(sent.content, sent.text);
      // plain-text mode (ntfy) and a failing webhook that must not break the request
      hooks.length = 0;
      await Promise.all([(await call(worker, { ...e, NOTIFY_FORMAT: "text" }, "/requests", { method: "POST", ctx, ip: "5.5.5.5", body: { proposal: batch([addPerson({ displayName: "B" })]) } })) && jobs.at(-1)]);
      assert.equal(hooks[0].type, "text/plain");
      globalThis.fetch = async (url, opt) => { if (String(url).startsWith("https://hooks.test")) throw new Error("webhook down"); return inner(url, opt); };
      const bad = await call(worker, e, "/requests", { method: "POST", ctx, ip: "6.6.6.6", body: { proposal: batch([addPerson({ displayName: "C" })]) } });
      assert.equal(bad.status, 201);
      await Promise.all(jobs);
    } finally { globalThis.fetch = inner; }
  });
  test("no webhook configured means no outbound call", async () => {
    let called = false;
    const inner = globalThis.fetch;
    globalThis.fetch = async (...a) => { called = true; return inner(...a); };
    try { assert.equal((await submit(batch([addPerson({ displayName: "Quiet" })]), { ip: "7.7.7.7" })).status, 201); } finally { globalThis.fetch = inner; }
    assert.equal(called, false);
  });
});

describe("review and approval", () => {
  const approve = (token, id, proposal, note = "") => call(worker, env, "/requests/" + id + "/approve", { method: "POST", token, body: { proposal, note } });

  test("only admins can list, approve or reject", async () => {
    const { id } = await (await submit(batch([addPerson({ displayName: "Meera" })]))).json();
    assert.equal((await call(worker, env, "/requests")).status, 401);
    assert.equal((await call(worker, env, "/requests/" + id + "/approve", { method: "POST", body: {} })).status, 401);
    assert.equal((await call(worker, env, "/requests/" + id + "/reject", { method: "POST", body: { note: "x" } })).status, 401);
  });
  test("lists pending requests oldest first with a true total", async () => {
    for (const n of ["A", "B"]) await submit(batch([addPerson({ displayName: n })]));
    const j = await (await call(worker, env, "/requests?status=pending", { token: await loginToken() })).json();
    assert.equal(j.total, 2); assert.equal(j.requests.length, 2);
    assert.ok(j.requests[0].createdAt <= j.requests[1].createdAt);
    assert.equal(j.requests[0].proposal.operation, "BATCH_UPDATE");
  });
  test("approving applies the changes, commits once, and marks the request approved", async () => {
    const token = await loginToken();
    const proposal = batch([addPerson({ id: "P000004", displayName: "Meera Rao", gender: "female" }), { type: "ADD_PARENT_CHILD", payload: { parentId: "P000001", childId: "P000004", role: "mother" } }]);
    const { id } = await (await submit(proposal)).json();
    const r = await approve(token, id, proposal, "Welcome");
    assert.equal(r.status, 200);
    assert.equal(gh.commits.length, 1);
    assert.match(gh.commits[0], new RegExp(id));
    assert.ok(gh.graph.persons.some((p) => p.id === "P000004" && p.displayName === "Meera Rao"));
    assert.ok(gh.graph.relationships.parentChild.some((x) => x.parentId === "P000001" && x.childId === "P000004"));
    assert.equal(env.DB.requests.get(id).status, "approved");
    assert.equal(env.DB.requests.get(id).note, "Welcome");
  });
  test("partial approval: only the chosen changes are applied", async () => {
    const token = await loginToken();
    const full = batch([addPerson({ id: "P000004", displayName: "Meera" }), { type: "ADD_SPOUSE", payload: { personAId: "P000003", personBId: "P000004" } }]);
    const { id } = await (await submit(full)).json();
    await approve(token, id, batch([full.payload.changes[0]]));
    assert.ok(gh.graph.persons.some((p) => p.id === "P000004"));
    assert.equal(gh.graph.relationships.spouses.length, 1);
  });
  test("a new person whose ID is taken gets a fresh ID and later changes follow it", async () => {
    const token = await loginToken();
    const proposal = batch([addPerson({ id: "P000003", displayName: "Old Cousin" }), { type: "ADD_PARENT_CHILD", payload: { parentId: "P000001", childId: "P000003", role: "mother" } }]);
    // child P000003 already has parent P000001 in the graph, so the link is only valid because it points at the *new* person
    const { id } = await (await submit(proposal)).json();
    assert.equal((await approve(token, id, proposal)).status, 200);
    const cousin = gh.graph.persons.find((p) => p.displayName === "Old Cousin");
    assert.notEqual(cousin.id, "P000003");
    assert.ok(gh.graph.relationships.parentChild.some((x) => x.parentId === "P000001" && x.childId === cousin.id));
    assert.equal(gh.graph.persons.find((p) => p.id === "P000003").displayName, "Kiran Rao");
  });
  test("a stale base version is refused and the request stays pending", async () => {
    const token = await loginToken();
    const proposal = batch([addPerson({ displayName: "Meera" })], { baseLastUpdated: "2020-01-01T00:00:00.000Z" });
    const { id } = await (await submit(proposal)).json();
    const r = await approve(token, id, proposal);
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /Stale/);
    assert.equal(env.DB.requests.get(id).status, "pending");
    assert.equal(gh.commits.length, 0);
  });
  test("double approval commits once", async () => {
    const token = await loginToken();
    const proposal = batch([addPerson({ displayName: "Meera" })]);
    const { id } = await (await submit(proposal)).json();
    const [a, b] = await Promise.all([approve(token, id, proposal), approve(token, id, proposal)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(gh.commits.length, 1);
    assert.equal(gh.graph.persons.filter((p) => p.displayName === "Meera").length, 1);
  });
  test("a failed commit releases the request back to pending", async () => {
    const token = await loginToken();
    const proposal = batch([addPerson({ displayName: "Meera" })]);
    const { id } = await (await submit(proposal)).json();
    gh.down = true;
    assert.ok((await approve(token, id, proposal)).status >= 400);
    gh.down = false;
    assert.equal(env.DB.requests.get(id).status, "pending");
    assert.equal((await approve(token, id, proposal)).status, 200);
  });
  test("a concurrent commit on GitHub is retried once on the fresh graph", async () => {
    const token = await loginToken();
    const proposal = batch([addPerson({ displayName: "Meera" })]);
    const { id } = await (await submit(proposal)).json();
    gh.conflictNext = 1;
    assert.equal((await approve(token, id, proposal)).status, 200);
    assert.ok(gh.graph.persons.some((p) => p.displayName === "Meera"));
  });
  test("changes that would corrupt the tree are blocked before anything is written", async () => {
    const token = await loginToken();
    // Kiran is already a child of Asha; making Asha a child of Kiran would create a loop.
    const proposal = batch([{ type: "ADD_PARENT_CHILD", payload: { parentId: "P000003", childId: "P000001" } }]);
    const { id } = await (await submit(proposal)).json();
    const r = await approve(token, id, proposal);
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /loop|ancestor/i);
    assert.equal(gh.commits.length, 0);
    assert.equal(env.DB.requests.get(id).status, "pending");
  });
  test("rejecting records the note and never touches GitHub", async () => {
    const token = await loginToken();
    const { id } = await (await submit(batch([addPerson({ displayName: "Meera" })]))).json();
    assert.equal((await call(worker, env, "/requests/" + id + "/reject", { method: "POST", token, body: { note: "Duplicate" } })).status, 200);
    assert.equal(env.DB.requests.get(id).status, "rejected");
    assert.equal(gh.commits.length, 0);
    assert.equal((await call(worker, env, "/requests/" + id + "/reject", { method: "POST", token, body: { note: "again" } })).status, 409);
  });
  test("direct admin apply validates, commits and supports dry runs", async () => {
    const token = await loginToken();
    const proposal = batch([addPerson({ displayName: "Direct Add" })]);
    assert.equal((await call(worker, env, "/admin/apply", { method: "POST", body: { proposal } })).status, 401);
    assert.equal((await call(worker, env, "/admin/apply", { method: "POST", token, body: { proposal, dryRun: true } })).status, 200);
    assert.equal(gh.commits.length, 0);
    const r = await call(worker, env, "/admin/apply", { method: "POST", token, body: { proposal } });
    assert.equal(r.status, 200);
    assert.equal(gh.commits.length, 1);
    assert.ok((await r.json()).data.persons.some((p) => p.displayName === "Direct Add"));
  });
});

describe("serving", () => {
  test("health reports the version and whether admin is configured", async () => {
    const j = await (await call(worker, env, "/health")).json();
    assert.equal(j.ok, true); assert.equal(j.adminConfigured, true); assert.ok(j.version);
  });
  test("the live tree is cached briefly, can be forced fresh, and falls back to the deployed copy", async () => {
    const assets = { fetch: async () => new Response(JSON.stringify({ persons: [], from: "assets" }), { headers: { "Content-Type": "application/json" } }) };
    const e = { ...env, ASSETS: assets };
    await call(worker, e, "/data/family.json?fresh=1");
    const reads = gh.reads;
    const first = await call(worker, e, "/data/family.json");
    assert.match(first.headers.get("Cache-Control"), /max-age=10/);
    await call(worker, e, "/data/family.json");
    assert.ok(gh.reads <= reads + 1, "cached reads do not hit GitHub every time");
    gh.down = true;
    assert.equal((await (await call(worker, e, "/data/family.json?fresh=1")).json()).from, "assets");
  });
  test("HTML is served with security headers and admin.html is never cached", async () => {
    const assets = { fetch: async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }) };
    const e = { ...env, ASSETS: assets };
    const idx = await call(worker, e, "/index.html");
    assert.match(idx.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
    assert.equal(idx.headers.get("X-Content-Type-Options"), "nosniff");
    const adm = await call(worker, e, "/admin.html");
    assert.match(adm.headers.get("Cache-Control"), /no-store/);
  });
  test("unexpected errors do not leak internals", async () => {
    const e = baseEnv({ DB: { prepare() { throw new Error("secret table name leaked"); } } });
    const r = await call(worker, e, "/health");
    assert.equal(r.status, 500);
    assert.ok(!/secret/.test(await r.text()));
  });
});
