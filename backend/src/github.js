import { HttpError, textToB64, b64ToText } from "./util.js";
import { applyProposal, integrityIssues, assertNoNewIssues, normalise } from "./graph.js";

const API = "https://api.github.com";
const contentsPath = (env) => "/repos/" + env.GITHUB_OWNER + "/" + env.GITHUB_REPO + "/contents/" + env.GITHUB_PATH;

export async function gh(env, path, opt = {}) {
  const r = await fetch(API + path, {
    ...opt,
    headers: {
      Accept: "application/vnd.github+json", Authorization: "Bearer " + env.GITHUB_TOKEN, "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "family-tree-community-worker", "Content-Type": "application/json", ...(opt.headers || {}),
    },
  });
  const t = await r.text();
  let b = {};
  try { b = JSON.parse(t); } catch { /* non-JSON error body */ }
  if (!r.ok) throw new HttpError(r.status, b.message || "GitHub " + r.status, { githubMessage: b.message || "", githubUrl: b.documentation_url || "" });
  return b;
}

/** Read the canonical family graph (and the blob sha needed to commit a new version). */
export async function getGraph(env) {
  const x = await gh(env, contentsPath(env) + "?ref=" + env.GITHUB_BRANCH);
  return { data: normalise(JSON.parse(b64ToText(x.content || ""))), sha: x.sha };
}

export const commitGraph = (env, data, sha, message) =>
  gh(env, contentsPath(env), { method: "PUT", body: JSON.stringify({ message, content: textToB64(JSON.stringify(data, null, 2) + "\n"), sha, branch: env.GITHUB_BRANCH }) });

/**
 * Apply a proposal on top of the latest graph and commit it. The result is integrity-checked before anything is written,
 * and a concurrent commit (sha mismatch) is retried once on the fresh graph.
 */
export async function applyAndCommit(env, proposal, message, { dryRun = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const g = await getGraph(env);
    const before = integrityIssues(g.data);
    applyProposal(g.data, proposal);
    assertNoNewIssues(before, integrityIssues(g.data));
    if (dryRun) return { data: g.data, commit: null };
    try {
      const commit = await commitGraph(env, g.data, g.sha, message);
      return { data: g.data, commit };
    } catch (e) {
      if (e.status === 409 && attempt === 0) continue;
      throw e;
    }
  }
}
