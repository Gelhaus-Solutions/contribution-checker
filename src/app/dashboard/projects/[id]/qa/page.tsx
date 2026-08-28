import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireProjectPermission } from "@/lib/authz";
import { roleAtLeast } from "@/lib/authz";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { formatDate, formatRelative } from "@/lib/ui/format";
import { countQa, isGreen, parseQaStatus } from "@/lib/qa/types";
import { resolveStagingConfig, stagingProjectSelect, stagingRepoSelect } from "@/lib/github/staging";
import { QaBoard, type QaBoardItem, type AiStepsView } from "./qa-board";
import { isAiTaskEnabled } from "@/lib/ai/registry";
import { parseAiConfig } from "@/lib/ai/config";
import { subjectKeys } from "@/lib/ai/prompt";
import { latestAiResult } from "@/lib/ai/run";
import { qaStepsTask } from "@/lib/ai/tasks/qa-steps";
import { releaseNarrativeTask } from "@/lib/ai/tasks/release-narrative";
import { generateReleaseNarrative } from "./actions";
import { SubmitButton } from "@/components/ui/submit-button";
import { BoardLinks, type BoardLinkRow } from "./board-links";

export const dynamic = "force-dynamic";

/** How many shipped batches the history list offers. */
const HISTORY_LIMIT = 12;

/** Advisory deploy-risk wording. Kept out of src/lib/ui/status.ts on purpose:
 * that module maps record statuses, and a model's guess is not one. */
const RISK_LABEL: Record<string, string> = {
  ROUTINE: "Routine release",
  ELEVATED: "Elevated risk",
  HIGH: "High risk",
};


type SearchParams = Record<string, string | string[] | undefined>;

function one(sp: SearchParams, key: string): string | null {
  const v = sp[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export default async function ProjectQa({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { role } = await requireProjectPermission(id, "project_prs_view");
  // Reviewers record verdicts. That is the whole job of this page, so anyone
  // who can see it can work it.
  const canVerify = roleAtLeast(role, "REVIEWER");
  // Connecting an external board means handing over credentials, so it is an
  // admin decision even though working the board is not.
  const canManageLinks = roleAtLeast(role, "ADMIN");

  const project = await prisma.project.findUnique({
    where: { id },
    select: { ...stagingProjectSelect, name: true, aiEnabled: true, aiConfig: true },
  });
  if (!project) return null;

  const repos = await prisma.repo.findMany({
    where: { projectId: id },
    select: { id: true, fullName: true, ...stagingRepoSelect },
    orderBy: { fullName: "asc" },
  });

  // Only repos that actually record QA. A repo that does not batch has no
  // release to verify, so listing it would offer an empty board with no
  // explanation.
  const qaRepos = repos.filter(
    (r) => resolveStagingConfig(project, r).qaEnabled,
  );

  if (qaRepos.length === 0) {
    return (
      <>
        <PageHeader
          title="QA"
          description="Verify what a staging batch ships before it ships."
        />
        <Card>
          <CardContent className="p-0">
            <EmptyState
              title="No repo is recording QA yet"
              description={
                <>
                  QA runs on the staging batch, so a repo needs the aggregate PR
                  turned on before it has a release to verify. Enable it under{" "}
                  <Link
                    href={`/dashboard/projects/${id}/staging`}
                    className="text-primary underline underline-offset-4"
                  >
                    Staging
                  </Link>
                  .
                </>
              }
            />
          </CardContent>
        </Card>
      </>
    );
  }

  const selectedRepoId = one(sp, "repo") ?? null;
  const repo =
    qaRepos.find((r) => r.id === selectedRepoId) ??
    // Default to a repo with work in flight rather than the alphabetical first,
    // which is usually the one nobody is releasing.
    (await pickBusiestRepo(qaRepos.map((r) => r.id))) ??
    qaRepos[0];

  const batchId = one(sp, "batch");
  const batch = batchId
    ? await prisma.stagingBatch.findFirst({
        where: { id: batchId, repoId: repo.id },
        include: { items: { include: { qaBy: { select: { ghLogin: true, name: true } } } } },
      })
    : await prisma.stagingBatch.findFirst({
        where: { repoId: repo.id, status: "OPEN" },
        orderBy: { openedAt: "desc" },
        include: { items: { include: { qaBy: { select: { ghLogin: true, name: true } } } } },
      });

  const boardLinks = await prisma.qaBoardLink.findMany({
    where: { repoId: repo.id },
    // Never the token or the key: this object is serialized to the client.
    select: {
      id: true,
      provider: true,
      targetId: true,
      enabled: true,
      hookId: true,
      lastPulledAt: true,
      lastError: true,
    },
    orderBy: { provider: "asc" },
  });
  const linkRows: BoardLinkRow[] = boardLinks.map((l) => ({
    id: l.id,
    provider: l.provider,
    targetId: l.targetId,
    enabled: l.enabled,
    hooked: l.hookId != null,
    lastPulledAt: l.lastPulledAt ? formatRelative(l.lastPulledAt) : null,
    lastError: l.lastError,
  }));

  const history = await prisma.stagingBatch.findMany({
    where: { repoId: repo.id, status: "SHIPPED" },
    orderBy: { shippedAt: "desc" },
    take: HISTORY_LIMIT,
    select: {
      id: true,
      prNumber: true,
      shippedAt: true,
      _count: { select: { items: true } },
    },
  });

  // Generated steps for every item on the board, in one query. Loaded here and
  // joined below rather than stored on StagingBatchItem, so a reconcile (which
  // re-derives every non-qa column) can never wipe them and they can never be
  // mistaken for something the author wrote.
  const aiStepsEnabled = isAiTaskEnabled(qaStepsTask, project, parseAiConfig(project.aiConfig));
  const aiStepsByItem = new Map<string, AiStepsView>();
  if (aiStepsEnabled && (batch?.items?.length ?? 0) > 0) {
    const keys = (batch?.items ?? []).map((i) => subjectKeys.batchItem(i.id));
    const rows = await prisma.aiResult.findMany({
      where: { taskId: qaStepsTask.id, subjectKey: { in: keys }, status: "OK" },
      orderBy: { createdAt: "desc" },
      select: { subjectKey: true, output: true, modelId: true, completedAt: true, createdAt: true },
    });
    for (const row of rows) {
      // Newest first, so the first row per subject wins and later ones are
      // superseded runs.
      if (aiStepsByItem.has(row.subjectKey) || !row.output) continue;
      const parsed = qaStepsTask.parse(safeJson(row.output));
      if (!parsed) continue;
      aiStepsByItem.set(row.subjectKey, {
        summary: parsed.summary,
        steps: parsed.steps,
        unknowns: parsed.unknowns,
        modelId: row.modelId,
        generatedAt: formatRelative(row.completedAt ?? row.createdAt),
      });
    }
  }

  const narrativeEnabled =
    batch != null &&
    isAiTaskEnabled(releaseNarrativeTask, project, parseAiConfig(project.aiConfig));
  const narrative = narrativeEnabled
    ? await latestAiResult({
        task: releaseNarrativeTask,
        subjectKey: subjectKeys.batch(batch.id),
      })
    : null;

  const items: QaBoardItem[] = (batch?.items ?? []).map((i) => ({
    id: i.id,
    key: i.key,
    kind: i.kind,
    prNumber: i.prNumber,
    title: i.title,
    authorLogin: i.authorLogin,
    summary: i.summary,
    qaSteps: i.qaSteps,
    labels: safeArray(i.labels),
    linkedIssues: safeNumbers(i.linkedIssues),
    qaStatus: parseQaStatus(i.qaStatus),
    qaNotes: i.qaNotes,
    qaAt: i.qaAt ? formatRelative(i.qaAt) : null,
    qaBy: i.qaBy?.ghLogin ?? i.qaBy?.name ?? i.qaByExternal ?? null,
    mergedAt: i.mergedAt ? formatRelative(i.mergedAt) : null,
    droppedAt: i.droppedAt ? formatDate(i.droppedAt) : null,
    externalUrl: i.externalUrl,
    aiSteps: aiStepsByItem.get(subjectKeys.batchItem(i.id)) ?? null,
  }));

  const counts = countQa(
    items.map((i) => ({
      qaStatus: i.qaStatus,
      droppedAt: i.droppedAt ? new Date() : null,
    })),
  );
  const green = isGreen(counts);
  const shipped = batch?.status === "SHIPPED";
  const prUrl =
    batch?.prNumber != null
      ? `https://github.com/${repo.fullName}/pull/${batch.prNumber}`
      : null;

  return (
    <>
      <PageHeader
        title="QA"
        description="Verify what a staging batch ships before it ships."
        meta={
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{repo.fullName}</span>
            {batch ? (
              <>
                <span aria-hidden="true">/</span>
                <span>
                  {shipped
                    ? `shipped ${batch.shippedAt ? formatDate(batch.shippedAt) : ""}`
                    : `open since ${formatDate(batch.openedAt)}`}
                </span>
              </>
            ) : null}
            {prUrl ? (
              <a
                href={prUrl}
                className="text-primary underline underline-offset-4"
                target="_blank"
                rel="noreferrer"
              >
                #{batch?.prNumber}
              </a>
            ) : null}
          </div>
        }
        actions={
          qaRepos.length > 1 ? (
            <nav className="flex flex-wrap gap-1">
              {qaRepos.map((r) => (
                <Link
                  key={r.id}
                  href={`/dashboard/projects/${id}/qa?repo=${r.id}`}
                  className={
                    r.id === repo.id
                      ? "rounded-md bg-muted px-2 py-1 text-xs font-medium"
                      : "rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50"
                  }
                >
                  {r.fullName.split("/")[1] ?? r.fullName}
                </Link>
              ))}
            </nav>
          ) : null
        }
      />

      {!batch ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              title="Nothing in flight"
              description="Nothing has been merged into the staging branch since the last release, so there is nothing to verify yet."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {counts.failed > 0 ? (
            <Alert variant="destructive">
              {counts.failed === 1
                ? "One item failed QA."
                : `${counts.failed} items failed QA.`}{" "}
              This batch should not ship until they are fixed or re-verified.
            </Alert>
          ) : green ? (
            <Alert variant="success">
              Everything in this batch has been verified. It is ready to ship.
            </Alert>
          ) : null}

          {narrativeEnabled && batch ? (
            <Card>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">Release narrative</CardTitle>
                  <CardDescription>
                    Model-written context for this batch. Advisory, and not part
                    of the release pull request.
                  </CardDescription>
                </div>
                <form action={generateReleaseNarrative}>
                  <input type="hidden" name="projectId" value={id} />
                  <input type="hidden" name="batchId" value={batch.id} />
                  {narrative ? (
                    <input type="hidden" name="force" value="1" />
                  ) : null}
                  <SubmitButton variant="outline" size="sm">
                    {narrative ? "Regenerate" : "Generate"}
                  </SubmitButton>
                </form>
              </CardHeader>
              <CardContent className="space-y-3">
                {!narrative ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing generated for this batch yet.
                  </p>
                ) : (
                  <>
                    <Badge variant="outline">
                      {RISK_LABEL[narrative.output.risk] ?? narrative.output.risk}
                    </Badge>
                    <p className="text-sm">{narrative.output.narrative}</p>
                    {narrative.output.watchFor.length > 0 ? (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">
                          Watch for
                        </p>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                          {narrative.output.watchFor.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      Generated {formatRelative(narrative.computedAt)}
                      {narrative.modelId ? ` by ${narrative.modelId}` : ""}.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>
                {shipped ? "Shipped batch" : "This batch"}{" "}
                <Badge variant="outline" className="ml-1 align-middle text-[10px]">
                  {counts.resolved}/{counts.total}
                </Badge>
              </CardTitle>
              <CardDescription>
                {counts.total === 0
                  ? "No items yet."
                  : [
                      `${counts.passed} verified`,
                      counts.failed > 0 ? `${counts.failed} failed` : null,
                      counts.skipped > 0 ? `${counts.skipped} skipped` : null,
                      counts.inReview > 0 ? `${counts.inReview} being verified` : null,
                      counts.pending > 0 ? `${counts.pending} untouched` : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <QaBoard
                projectId={id}
                items={items}
                repoFullName={repo.fullName}
                canVerify={canVerify && !shipped}
                aiStepsEnabled={aiStepsEnabled}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>External boards</CardTitle>
              <CardDescription>
                Mirror this checklist into Notion or Trello, in both directions.
                A verdict recorded on a card is pulled back here and counts
                toward the release gate the same as one recorded above.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BoardLinks
                projectId={id}
                repoId={repo.id}
                links={linkRows}
                canManage={canManageLinks}
              />
            </CardContent>
          </Card>

          {history.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Shipped releases</CardTitle>
                <CardDescription>
                  What went out before, and how much of it was verified.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y divide-border">
                  {history.map((h) => (
                    <li key={h.id} className="px-4 py-2.5 text-sm">
                      <Link
                        href={`/dashboard/projects/${id}/qa?repo=${repo.id}&batch=${h.id}`}
                        className="flex items-center justify-between gap-3 hover:text-primary"
                      >
                        <span>
                          {h.prNumber != null ? `#${h.prNumber}` : "Release"}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {h._count.items} item
                            {h._count.items === 1 ? "" : "s"}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {h.shippedAt ? formatDate(h.shippedAt) : ""}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}

/**
 * Prefer the repo whose batch actually needs attention. Opening the board on an
 * alphabetically-first repo with nothing in flight is the most common way a
 * multi-repo project sees an empty page and assumes the feature is broken.
 */
async function pickBusiestRepo(repoIds: string[]) {
  if (repoIds.length === 0) return null;
  const batch = await prisma.stagingBatch.findFirst({
    where: { repoId: { in: repoIds }, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    select: { repoId: true },
  });
  if (!batch) return null;
  return prisma.repo.findUnique({
    where: { id: batch.repoId },
    select: { id: true, fullName: true, ...stagingRepoSelect },
  });
}

/** JSON columns are strings; never trust one straight out of the database. */
function safeArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function safeNumbers(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is number => typeof v === "number")
      : [];
  } catch {
    return [];
  }
}

/** Tolerant parse for a stored AiResult payload, like every JSON column here. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
