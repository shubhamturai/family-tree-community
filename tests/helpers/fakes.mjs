// In-memory stand-ins for Cloudflare D1 and the GitHub contents API, enough to exercise the Worker end to end.
export function makeD1() {
  const requests = new Map(), limits = [];
  const db = {
    requests, limits,
    prepare(sql) {
      const make = (a) => {
          const stmt = {
            async first() {
              if (/SELECT 1 AS ok/.test(sql)) return { ok: 1 };
              if (/FROM rate_limits WHERE bucket/.test(sql)) return { n: limits.filter((r) => r.bucket === a[0] && r.ts > a[1]).length };
              if (/COUNT\(\*\) AS n FROM requests WHERE status='pending'/.test(sql)) return { n: [...requests.values()].filter((r) => r.status === "pending").length };
              if (/COUNT\(\*\) AS n FROM requests WHERE status=\?/.test(sql)) return { n: [...requests.values()].filter((r) => r.status === a[0]).length };
              if (/SELECT status FROM requests/.test(sql)) return requests.has(a[0]) ? { status: requests.get(a[0]).status } : null;
              if (/FROM requests WHERE id=\?/.test(sql)) return requests.get(a[0]) || null;
              throw new Error("fake D1: unhandled first(): " + sql);
            },
            async all() {
              if (/FROM requests WHERE status=\?/.test(sql)) return { results: [...requests.values()].filter((r) => r.status === a[0]).sort((x, y) => (x.created_at < y.created_at ? -1 : 1)).slice(0, 100) };
              throw new Error("fake D1: unhandled all(): " + sql);
            },
            async run() {
              if (/INSERT INTO rate_limits/.test(sql)) { limits.push({ bucket: a[0], ts: a[1] }); return { meta: { changes: 1 } }; }
              if (/DELETE FROM rate_limits/.test(sql)) return { meta: { changes: 0 } };
              if (/INSERT INTO requests/.test(sql)) {
                const [id, status, title, proposal_json, source, created_at, updated_at] = a;
                requests.set(id, { id, status, title, proposal_json, source, created_at, updated_at, note: null });
                return { meta: { changes: 1 } };
              }
              if (/SET status='processing'/.test(sql)) {
                const r = requests.get(a[1]);
                if (r && r.status === "pending") { r.status = "processing"; return { meta: { changes: 1 } }; }
                return { meta: { changes: 0 } };
              }
              if (/SET status='pending'/.test(sql)) {
                const r = requests.get(a[1]);
                if (r && r.status === "processing") r.status = "pending";
                return { meta: { changes: 1 } };
              }
              if (/UPDATE requests SET status=\?,note=\?/.test(sql)) {
                const [status, note, proposal, updated, id] = a, r = requests.get(id);
                Object.assign(r, { status, note, updated_at: updated });
                if (proposal) r.proposal_json = proposal;
                return { meta: { changes: 1 } };
              }
              throw new Error("fake D1: unhandled run(): " + sql);
            },
          };
          return stmt;
      };
      const direct = make([]);
      direct.bind = (...a) => make(a);
      return direct;
    },
  };
  return db;
}

export const sampleGraph = () => ({
  schemaVersion: 1,
  lastUpdated: "2026-01-01T00:00:00.000Z",
  persons: [
    { id: "P000001", firstName: "Asha", familyName: "Rao", displayName: "Asha Rao", gender: "female", recordStatus: "active" },
    { id: "P000002", firstName: "Ravi", familyName: "Rao", displayName: "Ravi Rao", gender: "male", recordStatus: "active" },
    { id: "P000003", firstName: "Kiran", familyName: "Rao", displayName: "Kiran Rao", gender: "male", recordStatus: "active" },
  ],
  relationships: {
    parentChild: [{ parentId: "P000001", childId: "P000003", role: "mother", order: 1 }, { parentId: "P000002", childId: "P000003", role: "father", order: 1 }],
    spouses: [{ personAId: "P000001", personBId: "P000002", order: 1, marriageDate: null, divorceDate: null }],
  },
});

/** Replace global fetch with a fake GitHub contents API holding `state.graph`. */
export function installGithub(state) {
  state.commits = []; state.reads = 0; state.conflictNext = 0; state.down = false;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opt = {}) => {
    const method = opt.method || "GET";
    if (!String(url).includes("/contents/")) return new Response(JSON.stringify({ message: "unexpected " + url }), { status: 500 });
    if (state.down) return new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });
    if (method === "GET") {
      state.reads++;
      return new Response(JSON.stringify({ sha: "sha" + state.commits.length, content: Buffer.from(JSON.stringify(state.graph)).toString("base64") }), { status: 200 });
    }
    const b = JSON.parse(opt.body);
    if (state.conflictNext > 0) { state.conflictNext--; state.commits.push("(conflicting writer)"); return new Response(JSON.stringify({ message: "sha does not match" }), { status: 409 }); }
    if (b.sha !== "sha" + state.commits.length) return new Response(JSON.stringify({ message: "sha does not match" }), { status: 409 });
    state.graph = JSON.parse(Buffer.from(b.content, "base64").toString());
    state.commits.push(b.message);
    return new Response(JSON.stringify({ commit: { sha: "c" + state.commits.length }, content: { sha: "sha" + state.commits.length } }), { status: 200 });
  };
  return () => { globalThis.fetch = real; };
}

export const baseEnv = (extra = {}) => ({
  DB: makeD1(), ADMIN_PASSWORD: "correct-horse-battery", GITHUB_TOKEN: "t", GITHUB_OWNER: "o", GITHUB_REPO: "r", GITHUB_PATH: "data/family.json", GITHUB_BRANCH: "main", ...extra,
});

export const call = (worker, env, path, { method = "GET", body, token, headers = {}, ip = "1.1.1.1", ctx } = {}) =>
  worker.fetch(new Request("https://x.test" + path, {
    method,
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...(token ? { Authorization: "Bearer " + token } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), env, ctx);
