# contribution-checker

Self-hosted Node.js app that gates pull requests behind a contributor application form. A GitHub App watches `pull_request.opened` events on linked repos. If the PR author hasn't been approved for that project, the App closes the PR with a friendly comment pointing to a public application page. Maintainers triage applications in a dashboard. On approval, previously-closed PRs are automatically reopened.

## Stack

- Next.js 15 (App Router) + Prisma + SQLite
- Auth.js v5 (GitHub OAuth) for sign-in
- GitHub App for repo automation (PR close/reopen/comment/label)
- Tailwind v4 + shadcn-style UI primitives
- Vitest for unit tests
- Docker + docker-compose for self-hosting

## Quick start (local development)

```bash
pnpm install
cp .env.example .env
# Fill in AUTH_SECRET (openssl rand -base64 32), AUTH_GITHUB_ID/SECRET
# (create an OAuth app at https://github.com/settings/developers)
# Add your GitHub login to SUPER_ADMINS so you can manage allowlist + setup.
pnpm exec prisma migrate dev
pnpm dev
# Open http://localhost:3000, sign in with GitHub.
# Visit /admin/setup to bootstrap the GitHub App via manifest.
```

## Production (Docker)

```bash
cp .env.example .env
# Fill AUTH_SECRET, AUTH_GITHUB_ID/SECRET, PUBLIC_BASE_URL, SUPER_ADMINS, SMTP_*.
# Update docker/Caddyfile with your domain.
docker compose -f docker/docker-compose.yml up -d
# 1) Visit https://your-domain.example/admin/setup as a super-admin.
# 2) Click the manifest button to create the GitHub App on github.com.
# 3) GitHub redirects back; copy the printed env block into .env.
# 4) docker compose -f docker/docker-compose.yml restart app.
# 5) Confirm at /admin — App is now configured.
```

## GitHub App setup walkthrough

The GitHub App is what gives the system permission to receive PR webhooks and to close/reopen/label PRs. It's separate from the OAuth App used for human sign-in. Set it up **once per instance**.

### 1. Prerequisites

- The instance is reachable on a public URL (`PUBLIC_BASE_URL` in `.env`). Local development with a tunnel like `ngrok` works too — just use the tunnel URL.
- Your GitHub login is in `SUPER_ADMINS` in `.env`. Sign in once so the flag gets applied.

> **Single-App mode (recommended):** one GitHub App handles both human sign-in and repo automation. Leave `AUTH_GITHUB_ID/SECRET` blank — the App's OAuth `client_id/secret` are reused for sign-in. The manifest at `/admin/setup` registers the right OAuth callback automatically.
>
> **Two-App mode:** if you want a separate OAuth App for sign-in, create one at https://github.com/settings/developers with callback `https://your-domain.example/api/auth/callback/github` and put its credentials in `AUTH_GITHUB_ID/SECRET`. Those take precedence over the App's OAuth credentials when set.

### 2. Create the App on GitHub (manual)

`/admin/setup` is a public page that shows the exact URLs you need. Open it once to copy them, then create the App at https://github.com/settings/apps/new (or under your org).

| Field on github.com | Value |
|---|---|
| Homepage URL | `${PUBLIC_BASE_URL}` |
| Webhook URL | `${PUBLIC_BASE_URL}/api/github/webhook` |
| Webhook secret | random string (`openssl rand -hex 32`) — store in `GITHUB_APP_WEBHOOK_SECRET` |
| Callback URL | `${PUBLIC_BASE_URL}/api/auth/callback/github` |

Permissions:

- **Repository: Pull requests** — Read & write
- **Repository: Issues** — Read & write
- **Repository: Metadata** — Read (auto-selected)
- **Account: Email addresses** — Read (so the app can email applicants)
- **Organization: Members** — Read *(optional, only for the auto-bypass-collaborators feature on org repos)*

Subscribe to events: **Pull request**, **Installation target**, **Installation repositories**.

After creating the App:

1. Generate a **private key** (downloads a `.pem` file).
2. Note the **App ID** and **Client ID**, and click **Generate a new client secret**.
3. Fill in your `.env`:
   ```bash
   GITHUB_APP_ID="..."
   GITHUB_APP_SLUG="..."          # last URL segment of the App
   GITHUB_APP_CLIENT_ID="..."
   GITHUB_APP_CLIENT_SECRET="..."
   GITHUB_APP_WEBHOOK_SECRET="..."
   # PEM on a single line with literal \n between lines, in double quotes:
   GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
   # Single-App mode: leave AUTH_GITHUB_ID/SECRET blank.
   ```
4. Restart the server. `/admin/setup` should now show a green "Configured" badge.

### 3. Install the App on a repo and link it

For every project that should be gated:

1. Create the project from `/dashboard` → **New project**. Choose a slug (this becomes `/p/<slug>`).
2. In the project, go to **Repos** tab → click **"Add repo via GitHub App"**. This sends you to GitHub to install the App. Pick **Only select repositories** and choose the repo(s).
3. GitHub redirects you back to a "Link repositories" page in the dashboard. Tick the repos you want gated and **Save selection**.
4. Done. Open a PR from a non-allowlisted GitHub account on that repo to test — the PR should be closed within a second or two with a comment pointing to `/p/<slug>`.

### 4. Verify

| What | How |
|---|---|
| Webhooks reaching your server | GitHub App → **Advanced** → **Recent Deliveries** should show 200 responses. |
| Decision flow | Open a PR → in the dashboard, **Applications** queue should not show one (the user hasn't applied yet); a `PrCheck` row was created with status `PENDING`. |
| Public landing | Visit `/p/<your-slug>` while signed out — you should see the apply form gated behind a sign-in button. |
| Approve flow | Submit an application as a second test account, approve it from the dashboard. The PR you opened should reopen automatically and switch labels. |

### 5. Permissions reference

The manifest requests exactly:

- **Repository: Pull requests** — read & write (close/reopen/label PRs)
- **Repository: Issues** — read & write (PR comments + label CRUD; PRs are issues for these endpoints)
- **Repository: Metadata** — read (required by GitHub for any installation)
- **Organization: Members** — read (used by the collaborator auto-bypass check)

Subscribed events: `pull_request`, `installation`, `installation_repositories`.

### Troubleshooting

- **"GitHub App not configured" after restart** — the env loader is strict about the PEM format. Make sure the value in `.env` is wrapped in double quotes and uses `\n` for newlines (the setup callback gives you exactly the right format).
- **Webhook deliveries show 401 Invalid signature** — `GITHUB_APP_WEBHOOK_SECRET` doesn't match. Re-check the value in `.env`.
- **PRs aren't being closed** — confirm the repo is linked under the project's Repos tab (not just installed in the GitHub App). The webhook ignores PRs from repos that aren't linked.
- **Collaborators are seeing their PRs blocked** — toggle off the "Auto-bypass repository collaborators" option on the project settings page if you want to gate collaborators too, or leave it on if you want them to skip the gate. The check is cached for 5 minutes.

## How a PR is gated

```
GitHub repo                  GitHub App                contribution-checker      SQLite
   │                             │                          │                        │
   │  PR opened ─────────────────▶  webhook delivery ──────▶│ decideForPR() ─────────┤
   │                             │                          │                        │
   │                             │◀── close PR + comment + label  ◀──── PENDING ─────┤
   │                                                        │                        │
   │  user opens /p/<slug>, signs in, submits application ──▶ store ─────────────────▶
   │  admin clicks Approve  ────────────────────────────────▶ update + reopen PRs ───▶
   │                             │◀── reopen prior closed PRs of this user ──┤       │
```

### Decision precedence

`decideForPR(repo, ghLogin, ghId)` checks (in order):

1. **Manual decision** for this `(project, ghLogin)` — if APPROVED/DENIED, that wins.
2. **Bypass list** — glob-matched against `Project.bypassHandles`. Match → bypassed.
3. **Repo collaborator check** (if `Project.bypassCollabs` is on) — collaborators bypass.
4. **Latest application** for `(project, user)` — APPROVED → approved, DENIED + active cooldown → denied, else → pending.

## Features

- GitHub App webhook gates `pull_request.opened` and `pull_request.reopened`.
- Public per-project landing page at `/p/<slug>` with sign-in-to-apply flow.
- Schema-builder application form (text/textarea/url/select/checkbox).
- Reusable form templates (per user).
- Three-tier project roles: OWNER / ADMIN / REVIEWER.
- Super-admin allowlist for project creation.
- Audit log per project.
- Internal admin-only notes on each application.
- In-app notifications + SMTP email + outbound webhooks (HMAC-signed, with retries).
- Rate limiting on the public apply endpoint.
- Configurable per-project denial cooldown (or permanent).
- Manual approve/deny list for any GitHub login (no application required).
- Bypass list for bots (`*[bot]` etc.) and optional auto-bypass for repo collaborators.
- Configurable per-project labels for `pending`, `approved`, `denied`.
- Approval reopens previously-closed PRs by the same user across all linked repos.
- Revocation modal with optional "close their open PRs" toggle.

## Configuration (env vars)

See [`.env.example`](./.env.example). Highlights:

- `DATABASE_URL` — SQLite file path (e.g. `file:./data/contribution-checker.db`)
- `PUBLIC_BASE_URL` — your canonical URL, used for emails/webhooks/redirects
- `AUTH_SECRET` — Auth.js session secret (`openssl rand -base64 32`)
- `AUTH_GITHUB_ID/SECRET` — OAuth app credentials for human sign-in (separate from the GitHub App)
- `GITHUB_APP_*` — GitHub App credentials, populated by `/admin/setup`
- `SUPER_ADMINS` — comma-separated GitHub logins, granted super-admin on first sign-in
- `PROJECT_CREATORS` — comma-separated logins, granted project-creation rights on first sign-in
- `SMTP_*` — optional, SMTP transport for email notifications

## Testing

```bash
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm build         # next build (also runs prisma generate)
```

## Repository layout

```
src/
├── app/
│   ├── (root)/                landing page + auth callbacks
│   ├── p/[slug]/              public project landing + apply form
│   ├── dashboard/             auth-gated user/admin dashboard
│   │   ├── projects/[id]/     per-project: overview, applications, decisions, repos, form, settings, audit
│   │   ├── notifications/     in-app notification inbox
│   │   └── templates/         user's saved form templates
│   ├── admin/                 super-admin (allowlist, GitHub App setup)
│   └── api/
│       ├── auth/              Auth.js v5 handlers
│       └── github/            App webhook + post-install + manifest callback
├── lib/
│   ├── applications/          form schema, submission lifecycle, PR decision logic
│   ├── github/                Octokit App, PR actions, collaborator cache, webhook dispatch
│   ├── notifications/         in-app inbox, SMTP email, outbound webhooks
│   ├── auth.ts / auth.config.ts   Auth.js setup (split for edge-safe middleware)
│   ├── authz.ts               role-based authz helpers (requireProjectRole etc.)
│   ├── audit.ts               append-only audit log writer
│   ├── ratelimit.ts           DB-backed sliding-window rate limit
│   └── env.ts                 Zod-validated environment
└── components/
    ├── ui/                    shadcn-style primitives (button, input, card, ...)
    ├── form-renderer.tsx      shared form rendering for builder preview + public apply page
    └── site-header.tsx        global nav with notification bell
```

## License

MIT.
