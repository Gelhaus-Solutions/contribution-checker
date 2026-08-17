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
4. If denied, the PR is closed with a "denied" label. The denial reason is
   **not** posted on GitHub; the applicant reads it on their status page.
5. If a CLA or DCO gate fires (`CHECK_REQUIRED`), the PR is **left open**, a
   comment explains what to sign or add, and the check fails.
6. A GitHub Check Run is published mirroring the decision (success /
   action_required / failure) so branch protection sees the gate. There is no
   `skipped` conclusion: the fourth state is "no check published at all", when
   `checksEnabled` is false, the payload has no head SHA, or the installation
   lacks `checks:write`.
7. If PR Quality scoring is enabled, a 0–100% heuristic score is computed and
   stored. Scores are admin-only by default, with a public warning comment when
   the score falls below the project's threshold.
8. When the application is later approved, all closed-by-app PRs from that user
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
- `src/lib/applications/decide-pr.ts`: precedence is repo active → disable
  switch → manual **DENIED** → bypass list → manual **APPROVED** →
  collaborator → application, then the CLA layer on top. Note the asymmetry:
  a manual denial short-circuits *before* the bypass list, while a manual
  approval is evaluated *after* it, which is what makes bots exempt from the
  CLA. Returns six statuses: `APPROVED`, `BYPASSED`, `PENDING`,
  `CHECK_REQUIRED`, `DENIED`, `IGNORED`.
- `src/lib/github/webhook.ts`: App webhook entrypoint; orchestrates close/
  label/comment + Check Run + Quality
- `src/app/api/github/webhook/route.ts`: signature verification + dispatch
- `src/app/api/ci/check-pr/route.ts`: CI mode entrypoint (OIDC-gated); returns
  a payload the workflow uses to mutate the PR
- `src/lib/github/post-decision.ts`: reopen prior closed PRs on application
  approval; close prior approved PRs on revoke

Staging routing (`src/lib/github/staging.ts`, App mode only):
- `applyStagingRouting`: rewrites a PR based on the default branch to target
  `Project.stagingBranch`. Runs in `handlePullRequestEvent` **before**, and
  independently of, `convergePr`. Loop-safe by construction: the retarget only
  fires when the current base *is* the default branch, so our own PATCH's
  `pull_request.edited` echo is inert. A per-process TTL fuse caps a genuine
  ping-pong with a human or a competing automation.
- `reconcileStagingBatch`: keeps one bot-owned aggregate PR open from staging to
  the default branch and rewrites the manifest between the
  `<!-- staging-batch:start/end -->` markers, preserving human text outside
  them. A full re-derivation from live GitHub, so it is safe to run any number
  of times; it PATCHes the body only when the rendered block actually changed.
  The batch cutoff is the merge base of `default...staging`, so it self-heals
  when a webhook is dropped.
- The aggregate PR must **never** reach `convergePr` (no application means the
  gate would close the bot's own release PR). `isAggregatePr` matches it by the
  tracked `Repo.stagingBatchPrNumber` and structurally (same-repo head ==
  staging, base == default), so the pre-tracking window is covered.
- The two staging labels live **outside** the `contribution:` namespace on
  purpose: `setLabels` strips every `contribution:*` label the gate did not just
  set, so a staging label there would be wiped by the next converge.
  `updateLabelSettings` rejects the prefix.

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
- **All background work is Temporal.** The old `JobQueue` table was dropped in
  `prisma/migrations/20260630120000_temporal_drop_legacy_queues`; there is no
  DB-polling runner to hook into. Start work via `src/lib/temporal/start.ts`
  with a deterministic id from `workflowIds` (`src/lib/temporal/task-queue.ts`),
  add the activity under `src/worker/activities/`, and register the workflow in
  `src/worker/workflows/index.ts`. Entity workflows: `projectGate` ->
  `contributorGate` -> `prGate`, plus the per-repo `stagingBatch`.
  `src/lib/temporal/contracts.ts` must stay import-light (types and plain
  constants only) because it is bundled into the deterministic workflow bundle.

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

## UI and design system

- **Tokens live in `src/app/globals.css`.** OKLCH values under `:root` and
  `.dark`, exposed to Tailwind through `@theme inline`. Because utilities
  compile to `var(--x)`, palette values can change without touching a single
  className. Add a token in both blocks *and* in `@theme inline`.
- **The accent is cobalt** (OKLCH hue 256). It is for links, focus rings, the
  primary button and active nav only. Green/amber/red are reserved for meaning.
- **Use the `-strong` label tokens on tonal surfaces.** `bg-success/12` with
  `text-success` fails WCAG AA; `text-success-strong` is the same hue moved to
  a lightness that passes. Badge and Alert already do this.
- **Dark mode is a `.dark` class**, set from the `cc-theme` cookie by the root
  layout and resolved for `system` by `src/app/theme-script.tsx` before paint.
  There is no `@media (prefers-color-scheme)` block; do not add one.
- **Status strings go through `src/lib/ui/status.ts`** (`<StatusBadge>`), and
  dates through `src/lib/ui/format.ts`. Do not write a local variant map or
  `.toISOString().slice(0, 10)` in a page. Both modules are JSX-free so they
  stay testable under the node-environment vitest config.
- **Selects and checkboxes stay native.** Nearly every one is inside a
  `<form action={serverAction}>` or the public application form, which must
  work with JS disabled. `ui/switch` is Radix and is only for booleans that
  apply immediately.
- **Marketing pages generate their artifacts from the real modules**:
  `buildDecisionMessage`, `buildDecisionCheckPayload` and `ALL_HEURISTICS`.
  Do not retype a bot comment or a heuristic list into a page; if the copy
  changes, the page should follow for free.
- `/for-contributors` is **load-bearing**: its URL is quoted in PR comments
  across other people's repositories. It must not move, 404, require auth, or
  depend on the database.

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

- Don't run GitHub side effects from background tasks outside Temporal. The
  webhook path uses inline awaits inside an activity; anything else starts a
  workflow via `src/lib/temporal/start.ts`.
- Don't `JSON.parse` JSON columns without a Zod schema or a parsing helper.
- Don't add an LLM dependency to quality scoring (see Conventions).
- Don't let webhook errors propagate up. GitHub will retry forever and the
  delivery will look "failed". Log and return 200 unless signature
  verification fails.
- Don't introduce per-installation tokens in the database. Always derive via
  `getInstallationOctokit`.

## Known gaps / follow-ups

- Staging routing is App mode only. CI mode (`src/lib/ci/check-pr-core.ts` and
  the generated workflow YAML) neither retargets nor maintains a batch PR.
- Retargeting only reaches existing open PRs through `reGateProjectPrs`, which
  fans out over `PrCheck` rows. PRs with no row (opened before the App was
  installed) retarget on their next event instead.
- If a repo's default branch is protected by a merge queue or required reviews
  and the staging branch is not, retargeting routes contributions around those
  rules and the aggregate PR becomes the only gate. Replicate the protection
  onto the staging branch.
- CI mode quality scoring depends on the workflow including `qualityContext`
  in the request body. Older workflow files may not have this; users need to
  copy the latest YAML from `/dashboard/projects/<id>/repos`.
- Backfill is capped at 200 rows per run to bound API usage. Re-run for
  larger projects or write a worker.
