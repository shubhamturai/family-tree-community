// Boots the real site in headless Chromium: real HTML/JS, real Cytoscape, and the real Worker (fake D1 + fake GitHub) on one origin.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import worker from "../../backend/worker.js";
import { baseEnv, installGithub } from "./fakes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "https://app.test";
const MIME = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
export const PASSWORD = "correct-horse-battery";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A synthetic multi-generation family: couples with children, whose children marry in. */
export function bigFamily(gens = 5, kids = 3) {
  const persons = [], pc = [], sp = [];
  let n = 0;
  const mk = (fn, fam, gender) => {
    const id = "P" + String(++n).padStart(6, "0");
    persons.push({ id, firstName: fn, familyName: fam, displayName: fn + " " + fam, gender, recordStatus: "active", dateOfBirth: "1950-01-01" });
    return id;
  };
  let couples = [[mk("Arjun", "Rao", "male"), mk("Meera", "Rao", "female")]];
  sp.push({ personAId: couples[0][0], personBId: couples[0][1], order: 1 });
  for (let g = 1; g < gens; g++) {
    const next = [];
    couples.forEach(([a, b], ci) => {
      for (let k = 0; k < kids; k++) {
        const c = mk("Child" + g + "_" + ci + "_" + k, "Rao", k % 2 ? "female" : "male");
        pc.push({ parentId: a, childId: c, role: "father", order: k + 1 }, { parentId: b, childId: c, role: "mother", order: k + 1 });
        if (g < gens - 1 && k < 2) {
          const s = mk("Spouse" + g + "_" + ci + "_" + k, "Iyer", k % 2 ? "male" : "female");
          sp.push({ personAId: c, personBId: s, order: 1 });
          next.push([c, s]);
        }
      }
    });
    couples = next;
  }
  return { schemaVersion: 1, lastUpdated: "2026-10-01T00:00:00.000Z", persons, relationships: { parentChild: pc, spouses: sp } };
}

export async function startApp({ graph, viewport = { width: 1440, height: 860 }, clock = false } = {}) {
  const env = baseEnv();
  const gh = { graph: graph || bigFamily(3, 2) };
  const restoreFetch = installGithub(gh);
  const assetResponse = async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/data/config.json") return new Response(JSON.stringify({ apiBase: ORIGIN }), { headers: { "Content-Type": "application/json" } });
    const file = path.join(ROOT, u.pathname === "/" ? "index.html" : u.pathname.slice(1));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response("Not found", { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" } });
  };
  env.ASSETS = { fetch: assetResponse };

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [], toasts = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("dialog", (d) => d.dismiss());
  if (clock) await page.clock.install();

  const cytoscapeJs = fs.readFileSync(path.join(ROOT, "node_modules/cytoscape/dist/cytoscape.min.js"), "utf8");
  const net = { workerCalls: [], githubFail: 0 };
  await page.route("**/*", async (route) => {
    const req = route.request(), u = new URL(req.url());
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (u.hostname === "unpkg.com") return route.fulfill({ contentType: "application/javascript", body: cytoscapeJs });
    if (u.origin === ORIGIN) {
      net.workerCalls.push(req.method() + " " + u.pathname);
      if (net.hold && u.pathname === net.hold.path) await net.hold.promise;
      const wr = await worker.fetch(new Request(req.url(), { method: req.method(), headers: { "CF-Connecting-IP": "2.2.2.2", ...req.headers() }, body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postData() }), env);
      return route.fulfill({ status: wr.status, headers: Object.fromEntries(wr.headers), body: Buffer.from(await wr.arrayBuffer()) });
    }
    if (u.hostname === "api.github.com") {
      // Direct GitHub access used by the admin editor (token-based). Backed by the same fake repository.
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (req.method() === "GET") return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ sha: "sha" + gh.commits.length, content: Buffer.from(JSON.stringify(gh.graph)).toString("base64") }) });
      if (net.githubFail > 0) { net.githubFail--; return route.fulfill({ status: 409, headers: cors, contentType: "application/json", body: JSON.stringify({ message: "data/family.json does not match" }) }); }
      const b = JSON.parse(req.postData());
      gh.graph = JSON.parse(Buffer.from(b.content, "base64").toString());
      gh.commits.push(b.message);
      return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ content: { sha: "sha" + gh.commits.length } }) });
    }
    return route.fulfill({ status: 404, body: "not stubbed: " + req.url() });
  });

  const app = {
    page, env, gh, net, errors, ORIGIN,
    /** Seed a pending request straight into the queue (as if a visitor had submitted it). */
    addRequest(id, created, changes, { base, meta } = {}) {
      const proposal = { operation: "BATCH_UPDATE", payload: { changes, ...(base !== undefined ? { baseLastUpdated: base } : { baseLastUpdated: gh.graph.lastUpdated }) } };
      if (meta) proposal.meta = meta;
      env.DB.requests.set(id, { id, status: "pending", title: "x", proposal_json: JSON.stringify(proposal), source: "public-web", created_at: created, updated_at: created, note: null });
    },
    async open(p = "/admin.html") { await page.goto(ORIGIN + p); },
    async unlock() { await page.fill("#password", PASSWORD); await page.click("#login"); await sleep(900); },
    toastText: () => page.evaluate(() => document.getElementById("toasts")?.innerText || ""),
    async close() { await browser.close(); restoreFetch(); },
  };
  return app;
}
