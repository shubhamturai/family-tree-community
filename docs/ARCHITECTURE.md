# Architecture

## Goals

1. A family tree anyone in the family can read and **suggest corrections to**, without accounts.
2. The administrator stays in control: **no change is published without explicit approval**, and approval is safe even for big trees and stale requests.
3. Cheap and boring to run, with a **complete, restorable history** — so the data lives in git and the service is a thin layer on top.

## Components

| Component | Tech | Responsibility |
|---|---|---|
| Public site `index.html` | static HTML + Cytoscape | Read-only exploration; local draft editing; submit suggestions; export |
| Admin Studio `admin.html` | static HTML + Cytoscape | In-tree review of requests; optional direct editing |
| Worker `backend/src` | Cloudflare Worker | Validation, queue, review API, applying changes, auth, serving the live tree |
| Queue | Cloudflare D1 (SQLite) | `requests` (pending / processing / approved / rejected) and `rate_limits` |
| Database of record | `data/family.json` in git | The family data; every approval is a commit |
| Deploy | GitHub Actions | Tests → deploy Worker + assets → apply schema → smoke tests |

The Worker also serves the static assets (`run_worker_first`), so pages, API and security headers share **one origin** (no CORS in practice).

## Request lifecycle

```
visitor edits locally ──▶ buildProposal() ──▶ POST /requests
                                              │ sanitizeProposal(): whitelist fields, validate ids/dates/lengths,
                                              │   ≤100 changes, ≤100 KB; per-client rate limit; queue cap
                                              ▼
                                           D1: status = pending         ──▶ optional webhook ping
administrator opens Admin Studio ─▶ GET /requests ─▶ tree + pending people ringed
   reviews change by change ─▶ per-request summary ─▶ POST /requests/:id/approve {accepted changes}
                                              │ claim: pending → processing (atomic; a double click or two admins cannot double-apply)
                                              │ sanitize again · fetch latest family.json · applyProposal()
                                              │ integrity check: refuse changes that introduce NEW damage
                                              │ commit to GitHub (sha-checked; one retry on a concurrent commit)
                                              ▼
                                           D1: approved (+ reviewer note)   ──▶ contributor sees it via /requests/:id/status
                                           push to main ──▶ Actions redeploy ──▶ public site serves the new tree
   any failure releases the claim ──▶ the request returns to pending
```

### Why per-change review is safe

- Changes are **independent, typed operations** (`ADD_PERSON`, `UPDATE_PERSON`, `DELETE_PERSON` (archive), `ADD_PARENT_CHILD`, `ADD_SPOUSE`). The admin accepts or rejects each one; dependencies are enforced (accepting a link accepts the person it needs; rejecting a person rejects the links that need them).
- The admin UI re-checks every change against the **current** tree and shows problems (person no longer exists, relationship already present, …); the Worker re-validates on approval.
- A request made on an older version of the tree is still reviewable: new people whose IDs are now taken get fresh IDs and the rest of the batch follows them.
- The approval is bound to the tree version the reviewer saw (`baseLastUpdated`); if the tree changes mid-review the Worker answers "stale" instead of guessing.

## Authentication

- `POST /admin/login {password}` → `{token, expiresAt}`. The password is compared in constant time; failures are rate-limited per client; the Worker fails closed if `ADMIN_PASSWORD` is not configured.
- The token is `base64url(claims).HMAC-SHA256(claims)` signed with a key derived from `SESSION_SECRET` (or `ADMIN_PASSWORD`), valid for 8 hours. Clients store only the token (`sessionStorage`); rotating the secret invalidates all sessions.
- All admin routes require a valid token. Public routes: `GET /data/family.json`, `POST /requests`, `GET /requests/:id/status`, `GET /health`.

## Data integrity

`integrityIssues(graph)` reports duplicate IDs, links to missing people, self-parents/self-spouses, duplicate links, invalid dates and **ancestor loops**. Approval compares the issues **before and after** the change and refuses anything that adds new ones, so pre-existing quirks never block unrelated approvals, and a bad request can never corrupt the tree.

## Performance and resilience

- `/data/family.json` is served live from GitHub with a 15 s in-isolate cache and `max-age=10, stale-while-revalidate=30`; the admin reads `?fresh=1`. If GitHub is rate-limited or down, the Worker serves the copy deployed with the site.
- The layout (`tree-layout.js`) is O(n log n) per generation row and lays out hundreds of people instantly; Cytoscape renders the canvas. The public page starts at a readable zoom for big trees (Fit shows everything), and the **Everyone** list gives direct access to anyone.
- Rate limiting is best effort: if the table is unavailable (for example mid-migration) requests are allowed rather than blocked.

## Security headers

HTML is served with a Content-Security-Policy (`script-src 'self' 'unsafe-inline' https://unpkg.com`, `connect-src 'self' https://api.github.com`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; `admin.html` is never cached. User-supplied text is always escaped when rendered; request IDs are never interpolated into inline handlers.

## Trade-offs (and why)

- **Git as the database**: free history, review diffs, trivial backup — at the cost of ~1 minute between approval and the redeployed static copy (the live route makes the tree fresh immediately) and the GitHub API rate limit (mitigated by caching).
- **One admin password**: appropriate for a family; sessions are short-lived and rate-limited. Multi-reviewer roles would need real accounts — a deliberate non-goal.
- **Single-file pages**: no build step, trivially hostable; shared logic that matters (layout) lives in `tree-layout.js` and has its own tests.
