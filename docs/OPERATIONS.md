# Operations

## One-time setup

1. **D1**: create a database `family-tree-community-db`, put its ID in `backend/wrangler.toml`. The deploy workflow applies `backend/schema.sql` on every deploy (it is idempotent).
2. **Worker secrets** (Cloudflare dashboard → Worker → Settings → Variables, or `wrangler secret put`):
   - `ADMIN_PASSWORD` — long and random.
   - `GITHUB_TOKEN` — fine-grained token, repository **Contents: read & write**, this repository only.
   - Optional: `SESSION_SECRET`, `NOTIFY_WEBHOOK_URL` (+ `NOTIFY_FORMAT=text` for ntfy).
3. **GitHub Actions secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
4. `data/config.json` → `apiBase` is the Worker URL.
5. Push to `main`: the workflows test, deploy, verify and smoke-test everything.

## Everyday

- **Review requests**: open `/admin.html`, unlock, press **Start reviewing** (or click an orange person). `A` accept · `R` reject · `←/→` move · finish with the summary.
- **Notifications**: set `NOTIFY_WEBHOOK_URL` and you are pinged when a request arrives (Slack/Discord incoming webhook, or `https://ntfy.sh/<topic>` with `NOTIFY_FORMAT=text`).
- **Change the admin password**: update `ADMIN_PASSWORD`; all sessions end automatically.
- **Back up / restore**: the tree *is* the git history of `data/family.json`; restore any version with `git revert` / `git checkout <sha> -- data/family.json`. The queue (D1) only holds pending/decided requests and can be exported with `wrangler d1 export`.
- **Roll back a bad approval**: revert the commit on `main`; the site redeploys.

## Health and diagnostics

- `GET /health` → `{ok, version, adminConfigured}`; the deploy workflow also prints the queue counts and latest requests.
- Contributors can check a request with the tracking link (`?request=<id>`); admins see the same IDs in `GET /requests`.
- **CI** (`.github/workflows/ci.yml`) runs all tests on every pull request; the API deploy runs the unit tests first.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Admin login says "Admin access is not configured" | `ADMIN_PASSWORD` secret is missing on the Worker |
| "Too many failed attempts" | 8 failed logins in 10 minutes from one network; wait, or clear rows in `rate_limits` |
| Approval fails with "These changes would damage the family tree" | The change would create a loop/duplicate; reject it or fix the data in `family.json` first |
| Approval fails with "Stale request" | The tree changed while reviewing; reopen the request (it is re-checked against the current tree) |
| Request stuck in `processing` | The Worker died between committing and recording the result. Check the commit history; if the change is there, set the row to `approved`, otherwise to `pending` |
| New approvals do not show up on the public site | The live route is immediate; the static copy follows after the deploy workflow finishes |
| Red check "Workers Builds: family-tree-community" on pull requests | The Cloudflare Git integration is a second, redundant deploy path (GitHub Actions already deploys). Disconnect it in Cloudflare → Workers → Settings → Build, or fix its root directory/name to match `backend/wrangler.toml` |

## Privacy checklist

`family.json` is public. Do not store phone numbers, addresses or ID numbers in it. Contributor names and messages live only in the D1 queue and are visible to the administrator.
