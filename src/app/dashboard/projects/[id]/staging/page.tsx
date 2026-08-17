import { prisma } from "@/lib/db";
import { requireProjectPermission } from "@/lib/authz";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState } from "@/components/empty-state";
import {
  resolveStagingConfig,
  stagingProjectSelect,
  stagingRepoSelect,
  type ResolvedStagingConfig,
} from "@/lib/github/staging";
import {
  compareBranches,
  installationHasContentsWrite,
  repoRef,
} from "@/lib/github/pr-actions";
import { env } from "@/lib/env";
import {
  reconcileRepoStagingBatch,
  updateRepoStagingSettings,
  updateStagingDefaults,
} from "./actions";

/** Live GitHub state for one repo, best-effort: every probe degrades to
 * "unknown" rather than failing the page. */
type RepoLiveState = {
  stagingExists: boolean | null;
  aheadBy: number | null;
  contentsWrite: boolean | null;
};

const UNKNOWN: RepoLiveState = {
  stagingExists: null,
  aheadBy: null,
  contentsWrite: null,
};

/**
 * How many repos we probe live. An admin page should not fan out an unbounded
 * number of GitHub calls on every render; past the cap the rows still show
 * their stored state, just without the live badges.
 */
const LIVE_PROBE_LIMIT = 25;

async function probeRepo(args: {
  fullName: string;
  installationId: number;
  defaultBranch: string | null;
  cfg: ResolvedStagingConfig;
}): Promise<RepoLiveState> {
  if (!args.defaultBranch) return UNKNOWN;
  const ref = repoRef(args.fullName, args.installationId);
  const [cmp, contentsWrite] = await Promise.all([
    compareBranches(ref, args.defaultBranch, args.cfg.stagingBranch).catch(
      () => undefined,
    ),
    installationHasContentsWrite(args.installationId).catch(() => null),
  ]);
  if (cmp === undefined) return { ...UNKNOWN, contentsWrite: contentsWrite ?? null };
  // compareBranches returns null when a branch is missing, which here means
  // the staging branch does not exist yet.
  return {
    stagingExists: cmp !== null,
    aheadBy: cmp?.aheadBy ?? null,
    contentsWrite: contentsWrite ?? null,
  };
}

function TriStateSelect({
  name,
  value,
  inheritedLabel,
}: {
  name: string;
  value: boolean | null;
  inheritedLabel: string;
}) {
  const current = value == null ? "inherit" : value ? "on" : "off";
  return (
    <select
      name={name}
      defaultValue={current}
      className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
    >
      <option value="inherit">Inherit ({inheritedLabel})</option>
      <option value="on">On</option>
      <option value="off">Off</option>
    </select>
  );
}

export default async function StagingSettings({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireProjectPermission(id, "project_settings_manage");

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      ...stagingProjectSelect,
      name: true,
      labelPending: true,
      labelApproved: true,
      labelDenied: true,
      labelEvaluate: true,
    },
  });
  if (!project) return null;

  const repos = await prisma.repo.findMany({
    where: { projectId: id },
    orderBy: { fullName: "asc" },
    select: {
      id: true,
      fullName: true,
      active: true,
      installationId: true,
      defaultBranch: true,
      stagingBatchPrNumber: true,
      stagingBatchSince: true,
      ...stagingRepoSelect,
    },
  });

  const resolved = repos.map((repo) => ({
    repo,
    cfg: resolveStagingConfig(project, repo),
  }));

  // Probe only repos that are actually doing something: App-mode, active, and
  // with at least one half of the feature switched on.
  const probeTargets = resolved.filter(
    ({ repo, cfg }) =>
      repo.active &&
      repo.installationId != null &&
      (cfg.retargetEnabled || cfg.batchPrEnabled),
  );
  const probed = probeTargets.slice(0, LIVE_PROBE_LIMIT);
  const liveByRepoId = new Map<string, RepoLiveState>();
  if (env.githubAppConfigured) {
    const states = await Promise.all(
      probed.map(({ repo, cfg }) =>
        probeRepo({
          fullName: repo.fullName,
          installationId: repo.installationId as number,
          defaultBranch: repo.defaultBranch,
          cfg,
        }).catch(() => UNKNOWN),
      ),
    );
    probed.forEach(({ repo }, i) => liveByRepoId.set(repo.id, states[i]));
  }

  const activeCount = resolved.filter(
    ({ repo, cfg }) => repo.active && cfg.retargetEnabled,
  ).length;
  const batchCount = resolved.filter(
    ({ repo, cfg }) => repo.active && cfg.batchPrEnabled,
  ).length;
  const missingContentsWrite = [...liveByRepoId.values()].some(
    (s) => s.stagingExists === false && s.contentsWrite === false,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Staging routing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Send contributions through a staging branch instead of straight to the
          default branch, then ship them to production in reviewable batches.
          App-mode repos only.
        </p>
      </div>

      {repos.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardContent className="pt-5">
              <div className="text-2xl font-semibold">{activeCount}</div>
              <div className="text-xs text-muted-foreground">
                repos retargeting to staging
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="text-2xl font-semibold">{batchCount}</div>
              <div className="text-xs text-muted-foreground">
                repos with an aggregate PR
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="text-2xl font-semibold font-mono">
                {project.stagingBranch}
              </div>
              <div className="text-xs text-muted-foreground">
                default staging branch
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {missingContentsWrite ? (
        <Alert variant="warning" title="Staging branch missing, and the App cannot create it">
          At least one repo has no <code>{project.stagingBranch}</code> branch,
          and the installation was not granted{" "}
          <strong>Contents: Read &amp; write</strong>. Those repos are skipped.
          Create the branch yourself, which is the safer option since that
          permission grants push access to every file in the repo, or accept the
          permission upgrade on the App installation.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Project defaults</CardTitle>
          <CardDescription>
            Applied to every repo that has not overridden them below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateStagingDefaults} className="space-y-4">
            <input type="hidden" name="projectId" value={id} />
            <div className="space-y-2">
              <Label htmlFor="stagingBranch">Staging branch</Label>
              <Input
                id="stagingBranch"
                name="stagingBranch"
                defaultValue={project.stagingBranch}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Created automatically from the default branch head if it does
                not exist, which needs the Contents: Read &amp; write
                permission. Without it, repos missing the branch are skipped
                with a warning and nothing else changes.
              </p>
            </div>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="stagingRetargetEnabled"
                value="1"
                defaultChecked={project.stagingRetargetEnabled}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">
                  Retarget PRs to the staging branch
                </span>
                <span className="block text-xs text-muted-foreground">
                  Every PR opened against the default branch is rewritten to
                  target staging, whatever the contributor gate decides.
                  Accounts on the bypass list, and PRs carrying the opt-out
                  label, keep targeting the default branch. GitHub recomputes
                  the merge base on retarget, so a PR&apos;s diff and CI results
                  can shift once staging diverges from the default branch.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="stagingBatchPrEnabled"
                value="1"
                defaultChecked={project.stagingBatchPrEnabled}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">
                  Keep an aggregate PR open from staging
                </span>
                <span className="block text-xs text-muted-foreground">
                  While staging is ahead of the default branch, one bot-owned PR
                  stays open, ready for review, listing every PR in the batch.
                  Merging it ships the batch; the next staging activity opens a
                  fresh one.
                </span>
              </span>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="labelStagingBatch">Batch label</Label>
                <Input
                  id="labelStagingBatch"
                  name="labelStagingBatch"
                  defaultValue={project.labelStagingBatch}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Carried by the aggregate PR so the bot can find it again if
                  the tracked number is lost.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="labelStagingOptOut">Opt-out label</Label>
                <Input
                  id="labelStagingOptOut"
                  name="labelStagingOptOut"
                  defaultValue={project.labelStagingOptOut}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Add it to a PR to keep that PR on the default branch. Cannot
                  use the <code>contribution:</code> prefix, which the gate owns
                  and strips.
                </p>
              </div>
            </div>
            <SubmitButton>Save defaults</SubmitButton>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-repo settings</CardTitle>
          <CardDescription>
            Override the project defaults for one repo, or leave a field on
            Inherit to follow them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {resolved.length === 0 ? (
            <EmptyState
              title="No repos linked"
              description="Link a repo on the Repos page before configuring staging routing."
            />
          ) : null}
          {resolved.map(({ repo, cfg }) => {
            const live = liveByRepoId.get(repo.id);
            const appMode = repo.installationId != null;
            const prUrl = repo.stagingBatchPrNumber
              ? `https://github.com/${repo.fullName}/pull/${repo.stagingBatchPrNumber}`
              : null;
            return (
              <div
                key={repo.id}
                className="rounded-md border border-border p-4 space-y-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={`https://github.com/${repo.fullName}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-sm font-medium hover:underline"
                  >
                    {repo.fullName}
                  </a>
                  {!repo.active ? (
                    <Badge variant="secondary">inactive</Badge>
                  ) : null}
                  {appMode ? null : (
                    <Badge variant="outline">CI mode, not supported</Badge>
                  )}
                  {cfg.retargetEnabled ? (
                    <Badge variant="success">retargeting</Badge>
                  ) : (
                    <Badge variant="secondary">no retarget</Badge>
                  )}
                  {cfg.batchPrEnabled ? (
                    <Badge variant="success">batching</Badge>
                  ) : (
                    <Badge variant="secondary">no batch</Badge>
                  )}
                </div>

                <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Default branch</dt>
                    <dd className="font-mono">
                      {repo.defaultBranch ?? "unknown"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Staging branch</dt>
                    <dd className="font-mono">
                      {cfg.stagingBranch}
                      {live?.stagingExists === false ? (
                        <span className="ml-1 text-warning-strong">
                          (missing)
                        </span>
                      ) : null}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Staging is ahead by</dt>
                    <dd>
                      {live?.aheadBy == null
                        ? "unknown"
                        : `${live.aheadBy} commit${live.aheadBy === 1 ? "" : "s"}`}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Aggregate PR</dt>
                    <dd>
                      {prUrl ? (
                        <a
                          href={prUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          #{repo.stagingBatchPrNumber}
                        </a>
                      ) : (
                        "none open"
                      )}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Last batch shipped</dt>
                    <dd>
                      {repo.stagingBatchSince
                        ? repo.stagingBatchSince.toISOString().slice(0, 10)
                        : "never"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground">Can create branches</dt>
                    <dd>
                      {live?.contentsWrite == null
                        ? "unknown"
                        : live.contentsWrite
                          ? "yes"
                          : "no (contents:write not granted)"}
                    </dd>
                  </div>
                </dl>

                <form
                  action={updateRepoStagingSettings}
                  className="grid items-end gap-3 sm:grid-cols-4"
                >
                  <input type="hidden" name="projectId" value={id} />
                  <input type="hidden" name="repoId" value={repo.id} />
                  <div className="space-y-1.5">
                    <Label htmlFor={`retarget-${repo.id}`} className="text-xs">
                      Retarget
                    </Label>
                    <TriStateSelect
                      name="stagingRetargetEnabled"
                      value={repo.stagingRetargetEnabled}
                      inheritedLabel={
                        project.stagingRetargetEnabled ? "on" : "off"
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`batch-${repo.id}`} className="text-xs">
                      Aggregate PR
                    </Label>
                    <TriStateSelect
                      name="stagingBatchPrEnabled"
                      value={repo.stagingBatchPrEnabled}
                      inheritedLabel={
                        project.stagingBatchPrEnabled ? "on" : "off"
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`branch-${repo.id}`} className="text-xs">
                      Staging branch
                    </Label>
                    <Input
                      id={`branch-${repo.id}`}
                      name="stagingBranch"
                      defaultValue={repo.stagingBranch ?? ""}
                      placeholder={project.stagingBranch}
                      className="font-mono"
                    />
                  </div>
                  <SubmitButton variant="outline">Save</SubmitButton>
                </form>

                {appMode && cfg.batchPrEnabled && repo.active ? (
                  <form action={reconcileRepoStagingBatch}>
                    <input type="hidden" name="projectId" value={id} />
                    <input type="hidden" name="repoId" value={repo.id} />
                    <SubmitButton variant="ghost" size="sm">
                      Reconcile now
                    </SubmitButton>
                  </form>
                ) : null}
              </div>
            );
          })}
          {probeTargets.length > probed.length ? (
            <p className="text-xs text-muted-foreground">
              Live branch state shown for the first {LIVE_PROBE_LIMIT} enabled
              repos only, to bound the GitHub calls this page makes. The rest
              still route normally.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How it behaves</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Retargeting runs independently of the contributor gate, so a PR
            still awaiting an application is retargeted before it is closed and
            arrives on staging if it is later approved.
          </p>
          <p>
            If someone moves a PR back to the default branch, the bot moves it
            to staging again. Add the{" "}
            <code className="font-mono">{project.labelStagingOptOut}</code>{" "}
            label to settle it permanently. Repeated fights trip a fuse and the
            bot backs off.
          </p>
          <p>
            The aggregate PR is exempt from the gate and from retargeting, and
            the bot owns only the block between its markers, so anything you
            write above or below it in the description survives.
          </p>
          <p>
            If your default branch is protected by required reviews or a merge
            queue and the staging branch is not, retargeting routes
            contributions around that protection and the aggregate PR becomes
            the only gate. Replicate the protection onto the staging branch.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
