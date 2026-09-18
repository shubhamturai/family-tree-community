# Family Tree Community

A **zero-server genealogy community graph** built on GitHub Pages + GitHub Issues + GitHub Actions.

## Architecture

- GitHub Pages serves the static family graph.
- `data/family.json` is the canonical approved public graph.
- The website prepares structured proposals as GitHub Issues.
- The community can submit proposals openly in V1.
- An admin reviews a proposal and adds `family:approved`.
- GitHub Actions validates the proposal, updates the canonical graph, comments on the issue, and marks it applied.
- Git history is the audit trail.

## Public vs protected data

The public graph may contain:
- Name
- Gender
- Birth/death date when appropriate
- Birth/death place
- City/region location
- Parents
- Children
- Spouses
- Marriage/divorce events
- Occupation
- Biography/notes
- Verification/source metadata

The public GitHub workflow deliberately does **not** collect:
- Aadhaar
- Mobile number
- Email address
- Exact residential address
- Government IDs
- Sensitive private notes

Those fields require a separate protected store. They must not be placed in the public repository or public GitHub Issues.

## Local run

```bash
python3 -m http.server 8080
```

Open http://localhost:8080

## Initial demo data

Replace `data/family.json` with your real family data when ready.
