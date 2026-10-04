# Family Graph

An interactive family tree that the whole family can help keep correct.

Anyone can **explore** the tree and **suggest changes**; nothing becomes part of the tree until the family
administrator **reviews it — one change at a time, on the tree itself** — and approves it.
Git is the database, so every approved change is a commit: a complete, restorable history.

```
 visitors ──▶ index.html ──suggest──▶ ┌────────────── Cloudflare Worker ──────────────┐
 (static site, Cytoscape)             │ validate · rate-limit · queue (D1)             │
                                      │ review API · apply + integrity check           │──commit──▶ data/family.json
 administrator ─▶ admin.html ─────────▶ signed session tokens · GitHub (token kept     │            (this repository)
 (Admin Studio: review on the tree)   │ server-side)                                   │                │
                                      └────────────────────────────────────────────────┘                ▼
                                                                                      GitHub Actions redeploy the site
```

## What you can do

**Visitors**
- Explore a clear generational tree (couples side by side, children below parents), search by name, switch to a force-directed network view, and highlight any person's direct family line.
- Find anyone in the **Everyone** list (also the screen-reader/keyboard-friendly way to browse), works on phones.
- **Suggest changes**: edit in place (add people, fix details, connect relatives, archive), review a summary, add an optional name and reason, and send. You get a **tracking link**; the Changes tab lists your requests and the reviewer's decision.
- **Export** the tree as JSON or **GEDCOM** (opens in Ancestry, FamilySearch, Gramps, …), or print it. Light and dark themes.

**Administrator (Admin Studio — `admin.html`)**
- The whole tree with every person who has a pending request ringed in orange.
- **Guided review in the tree**: requests oldest first, one change at a time. The camera flies to the people involved, everything else dims, and the proposed change appears as a ghost node/link on the real tree. Accept / Reject / Back / Next (`A`, `R`, `←`, `→`).
- Nothing is applied until a per-request summary ("Apply 2 accepted changes · 1 rejected"). The tree is reloaded after every apply and the next request is re-checked against it.
- Requests made on an older tree are flagged and every change is re-validated against the current one; clashing IDs are re-assigned automatically.
- Optional direct editing (with a GitHub token that stays in memory) and a notification webhook for new requests.

## Repository map

| Path | What it is |
|---|---|
| `index.html` | Public site: tree, editing, suggestions, tracking, export |
| `admin.html` | Admin Studio: in-tree review, direct editing |
| `tree-layout.js` | Generational layout shared by both pages (unit-tested) |
| `data/family.json` | **The family data** — the single source of truth |
| `data/config.json` | Where the API lives (`apiBase`) |
| `backend/src/*` | Worker: `index` (routes), `auth`, `validate`, `graph`, `github`, `requests`, `ratelimit`, `notify`, `http`, `util` |
| `backend/schema.sql` | D1 tables (`requests`, `rate_limits`) |
| `tests/` | Unit tests (Worker, graph integrity, layout) and browser tests (real pages + real Worker) |
| `.github/workflows/` | CI, API deploy, Pages-app deploy, GitHub Pages redirect, post-deploy smoke test |
| `docs/` | [Architecture](docs/ARCHITECTURE.md) · [Operations](docs/OPERATIONS.md) |

## Develop

```bash
npm install
npx playwright install chromium     # first time only
npm test                            # unit + browser tests (about a minute)
npm run test:unit                   # Worker, validation, graph integrity, layout — seconds
```

The browser tests start the real pages, real Cytoscape and the real Worker against in-memory fakes of D1 and GitHub, on one origin
and with the real security headers — so what passes here is what ships. CI runs the same on every pull request, and the API deploy
refuses to run if the unit tests fail.

To try the Worker locally: `cd backend && npx wrangler dev` (needs the secrets below in a `.dev.vars` file and a local D1:
`npx wrangler d1 execute family-tree-community-db --local --file=schema.sql`).

## Configuration (Worker secrets / variables)

| Name | Required | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Administrator password (long and random). Changing it signs everyone out. |
| `GITHUB_TOKEN` | yes | Fine-grained token with **Contents: read & write** on this repository only. Never sent to browsers. |
| `SESSION_SECRET` | no | Separate signing key for admin sessions (defaults to a key derived from `ADMIN_PASSWORD`). |
| `NOTIFY_WEBHOOK_URL` | no | Slack / Discord / ntfy URL pinged when a request arrives. `NOTIFY_FORMAT=text` for ntfy. |
| `GITHUB_OWNER/REPO/PATH/BRANCH` | set in `wrangler.toml` | Where `family.json` lives. |

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for setup, backups, rotation and troubleshooting.

## Privacy and safety by design

- The public tree contains only what you put in `family.json` — no accounts, no analytics, no third-party trackers (the only external script is Cytoscape from unpkg).
- Suggestions are validated and size-limited on the server, rate-limited per client, and can never touch the tree without approval. Contributors see only their own request's status.
- The administrator signs in once and receives a signed 8-hour session token; the password is never stored in the browser. The GitHub token never leaves the Worker (except the optional direct-edit mode, where you paste your own token, kept in memory only).
- Before anything is committed the result is **integrity-checked** (no duplicate IDs, dangling links, self-links or ancestor loops), and a concurrent commit is retried on the fresh data.
