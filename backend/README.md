# Family Graph Request API

This directory contains the serverless request queue used by the public Family Graph editor.

## What it does

- Public users submit one BATCH_UPDATE request with no GitHub redirect.
- Requests are stored privately in Cloudflare D1.
- Admins authenticate with the configured ADMIN_PASSWORD.
- Admins can review, approve, or reject requests in Admin Studio.
- Approval validates the proposal against the current data/family.json and commits the approved graph update to GitHub.
- GitHub Issues are not used as the request queue.

## Cloudflare setup

1. Create a Cloudflare D1 database named family-graph-requests.
2. Run schema.sql against that database.
3. Put the database ID into backend/wrangler.toml.
4. Set Worker secrets: GITHUB_TOKEN (fine-grained GitHub Contents read/write access to this repository) and ADMIN_PASSWORD (a long random administrator password).
5. Deploy the Worker with Wrangler.
6. Copy the resulting Worker URL into data/config.json as apiBase.
7. Set GitHub Actions secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID for automatic subsequent Worker deployments.

Never put either secret in this repository or browser JavaScript.
