# CLAUDE.md

Guide for Claude Code (and humans) working in this repository. Read this before
making non-trivial changes.

## What this is

Self-hosted Next.js app that gates GitHub pull requests behind a contributor
application form. When an unapproved user opens a PR on a linked repo:

1. The bot evaluates the author against the project's rules (manual decisions,
   bypass list, collaborator bypass, application status).
2. If approved/bypassed, the PR is left open and labeled.
3. If pending (no application), the PR is closed with a comment linking to the
   apply page, labeled "pending".
4. If denied, the PR is closed with the denial reason and a "denied" label.
5. A GitHub Check Run is published mirroring the decision (success /
   action_required / failure / skipped) so branch protection sees the gate.
6. If PR Quality scoring is enabled, a 0–100% heuristic score is computed and
   stored. Scores are admin-only by default, with a public warning comment when
   the score falls below the project's threshold.
7. When the application is later approved, all closed-by-app PRs from that user
   are reopened.

The bot runs in two modes per repo:

- **App mode**: installed as a GitHub App, receives webhooks. Recommended.
- **CI mode**: uses GitHub Actions OIDC tokens. The workflow file is generated
  per-project and dropped into the repo's `.github/workflows/`.

## Tech stack

- Next.js 15 App Router + React 19
- Prisma + PostgreSQL
- Hexclave (self-hosted Stack Auth fork, `@hexclave/next`) for human login;
  GitHub OAuth is configured inside Hexclave. Cookie sessions + edge middleware.
- `@octokit/app` + `@octokit/webhooks` for the App
- `jose` for verifying GitHub Actions OIDC JWTs
- Tailwind v4 + shadcn-style UI primitives
- pino logger, Zod for validation
- Vitest (unit), Playwright (e2e)

## Critical files

Decision pipeline:
- `src/lib/applications/decide-pr.ts`: precedence is disable switch → manual →
  bypass → collaborator → application
- `src/lib/github/webhook.ts`: App webhook entrypoint; orchestrates close/
  label/comment + Check Run + Quality
- `src/app/api/github/webhook/route.ts`: signature verification + dispatch
- `src/app/api/ci/check-pr/route.ts`: CI mode entrypoint (OIDC-gated); returns
  a payload the workflow uses to mutate the PR
- `src/lib/github/post-decision.ts`: reopen prior closed PRs on application
  approval; close prior approved PRs on revoke

GitHub side effects (all Octokit calls):
- `src/lib/github/pr-actions.ts`: close/reopen, labels, comments, Check Runs
- `src/lib/github/check-run.ts`: `buildDecisionCheckPayload` (pure mapping)
  and `publishDecisionCheck` (App-mode publisher with feature-detect)
- `src/lib/github/collaborators.ts`: LRU-cached collaborator probe

Quality (heuristic-only, no LLMs):
- `src/lib/quality/types.ts`: `Heuristic`, `PrContext`, `SignalsRaw`
- `src/lib/quality/registry.ts`: heuristic catalog + project config helpers
- `src/lib/quality/score.ts`: pure score formula; reads stored signals
- `src/lib/quality/fetch.ts`: App-mode PR/files/commits/account fetching
- `src/lib/quality/run.ts`: `runQualityForPrCheck` (App) and
  `runQualityFromContext` (CI)
- `src/lib/quality/heuristics/{size,prText,commits,code,account,diffCohesion}.ts`

Application lifecycle:
- `src/lib/applications/lifecycle.ts`: submission validation
- `src/lib/applications/decide.ts`: approve/deny/revoke + audit + notifications
- `src/lib/applications/schema.ts`: form-field schema + Zod validators

Audit, notifications, jobs:
- `src/lib/audit.ts`: `recordAudit` + `AuditKind` union (extend here when
  adding new audit kinds)
- `src/lib/notifications/{inbox,email,webhooks}.ts`
- Database job queue lives in `JobQueue` (see schema). Workers/runners are
  outside this index. The current state of the runner is repo-local; check for a
  worker module before assuming reliability.

## Conventions

- **Prefer editing existing files**. Don't create new modules unless the
  responsibility doesn't fit anywhere existing.
- **Server actions** live next to the page that uses them, in `actions.ts`.
- **JSON columns are strings.** Always parse via the helpers in
  `src/lib/quality/registry.ts` (or write a Zod schema in
  `src/lib/*/schema.ts`). Never `JSON.parse` and trust the result.
- **Octokit calls** go through `getInstallationOctokit(installationId)`. When
  rate-limit-sensitive, cache results following the LRU pattern in
  `collaborators.ts`.
- **Side effects on PRs** (close/reopen/label/comment/check) should be
  idempotent. The existing pattern is to do them inline with try/catch and
  log warnings on failure. Failures must not crash the webhook handler.
- **Audit every admin-visible state change** via `recordAudit`. Add the
  matching string literal to `AuditKind` in `src/lib/audit.ts` first.
- **No LLM dependency in quality scoring.** All heuristics are deterministic
  and pure given a `PrContext`. Adding an LLM call here would re-architect
  the module and is intentionally out of scope.
- **Disable switch contract:** when `Project.checkerEnabled === false`,
  `decideForRepo` returns `APPROVED { bypassReason: "checker_disabled" }`.
  The webhook handler must NOT close the PR or apply pending/denied labels.
  Whether to create a `PrCheck` row is gated on `Project.trackWhenDisabled`.
- **Never use em-dashes** (the long dash, Unicode U+2014). Reformat the sentence
  so none is needed (a colon, comma, parentheses, or two sentences). This applies
  to code, comments, UI copy, and docs. The en-dash (U+2013) in numeric ranges
  like `0–100` is fine.
- **Commit regularly, one commit per feature.** Each commit should be a single
  logical change with a clear message. Don't batch unrelated changes together.
- **Never add AI attribution to commits.** Do not include a `Co-Authored-By:
  Claude` trailer, any other AI/Claude co-author, or a "Generated with" line in
  commit messages or PR descriptions.

## Auth & roles

- Login is Hexclave (`@hexclave/next`). `auth()` (`src/auth.ts`) reads the
  Hexclave cookie session, resolves it to the local `User` row by
  `stackUserId`, and returns the same `session.user` shape as before, so
  consumers and `requireSession()`/`requireProjectRole()` are unchanged.
- Onboarding gate: `requireSession()` redirects to `/welcome` until the user
  has a linked GitHub identity (`ghId`); `/welcome` forces a GitHub connect for
  non-GitHub signups. The `country` code is captured automatically in the
  background (Hexclave's best-effort geo `countryCode`, mirrored to
  `User.country` by `captureGeoCountry`) — the user is never prompted, and it is
  not gated on. Edge `middleware.ts` does a fast cookie-presence gate for
  `/dashboard` and `/admin`.
- Org roles (super-admin, can-create-project) are **Hexclave project
  permissions** (`super_admin` / `create_project`) — Hexclave is the source of
  truth. `User.isSuperAdmin` / `User.canCreateProj` are mirror cache columns
  read on the hot path; reconciled on sign-in from `SUPER_ADMINS`/
  `PROJECT_CREATORS` (additive) and managed via `/admin/allowlist`, which
  grants/revokes the Hexclave permission. The operator must define these two
  project permissions in Hexclave.
- Per-project: `ProjectMember.role` ∈ {`OWNER`, `ADMIN`, `REVIEWER`} stays
  **local**. `requireProjectRole(projectId, minRole)` enforces this in server
  components and actions.
- Approval/denial requires REVIEWER. Settings/team/quality/people require
  ADMIN. Project deletion requires OWNER.
- The bot's GitHub App installation (`getInstallationOctokit`,
  `Repo.installationId`) is independent of login and unchanged.

## Adding a new quality heuristic

1. Drop a file in `src/lib/quality/heuristics/<group>.ts` exporting one or
   more `Heuristic` objects.
2. Add it to `ALL_HEURISTICS` in `src/lib/quality/registry.ts`.
3. The settings UI auto-renders the new heuristic in its group. The score
   formula and storage are unchanged. The heuristic id appears in
   `PrQuality.signalsRaw` after the next run.
4. No DB migration needed.

## Operational runbook

```bash
pnpm install
pnpm db:migrate          # applies pending Prisma migrations
pnpm dev                 # http://localhost:3000
pnpm typecheck           # tsc --noEmit
pnpm test                # vitest
pnpm test:watch
pnpm test:e2e            # Playwright
pnpm build && pnpm start
```

DBs:

- Dev: `data/contribution-checker.db`
- Tests: `data/test.db` (configured in `vitest.config.ts`)

Manual GitHub App setup is documented in-app at `/admin/setup`. The required
permissions are listed there; `checks:write` is required for status checks
and `contents:read` is required for PR Quality scoring (file diff fetching).

## Don'ts

- Don't bypass `JobQueue` (or the inline retry pattern) for GitHub side
  effects from background tasks. The webhook path uses inline awaits today.
- Don't `JSON.parse` JSON columns without a Zod schema or a parsing helper.
- Don't add an LLM dependency to quality scoring (see Conventions).
- Don't let webhook errors propagate up. GitHub will retry forever and the
  delivery will look "failed". Log and return 200 unless signature
  verification fails.
- Don't introduce per-installation tokens in the database. Always derive via
  `getInstallationOctokit`.

## Known gaps / follow-ups

- The `JobQueue` table exists; if you're adding a worker, prefer reusing the
  existing kinds (`pr.close`, `pr.reopen`, `pr.comment`, `pr.label.set`,
  `webhook.deliver`) before adding new ones.
- CI mode quality scoring depends on the workflow including `qualityContext`
  in the request body. Older workflow files may not have this; users need to
  copy the latest YAML from `/dashboard/projects/<id>/repos`.
- Backfill is capped at 200 rows per run to bound API usage. Re-run for
  larger projects or write a worker.
