import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireProjectRole } from "@/lib/authz";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormBuilder } from "../form/builder";
import { parseFormSchema } from "@/lib/applications/schema";
import { VersionEditor } from "./version-editor";
import { RepoSourcePanel } from "./repo-source-panel";
import { RepoFilePublishForm } from "./repo-file-publish-form";
import { VersionHistory, type HistoryVersion } from "./version-history";
import { PendingChanges, type PendingItem } from "./pending-changes";
import type { PriorVersion } from "./prior-version-resign-list";
import {
  updateClaSettings,
  saveIclaCustomFields,
  saveCclaCustomFields,
  notifyUnsignedApplicants,
} from "./actions";

export default async function ClaSettings({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireProjectRole(id, "ADMIN");

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return null;

  const [repos, versions, pending] = await Promise.all([
    prisma.repo.findMany({
      where: { projectId: id },
      orderBy: { fullName: "asc" },
      select: { id: true, fullName: true, installationId: true },
    }),
    prisma.claDocumentVersion.findMany({
      where: { projectId: id },
      orderBy: [{ kind: "asc" }, { version: "desc" }],
      select: {
        id: true,
        kind: true,
        version: true,
        contentHash: true,
        sourceType: true,
        sourceRepoId: true,
        sourcePath: true,
        sourceRef: true,
        sourceCommitSha: true,
        requireResign: true,
        resignRequired: true,
        publishedAt: true,
      },
    }),
    prisma.claPendingChange.findMany({
      where: { projectId: id, status: "PENDING" },
      orderBy: { detectedAt: "desc" },
      select: {
        id: true,
        kind: true,
        sourcePath: true,
        sourceRef: true,
        detectedCommitSha: true,
        detectedContent: true,
        detectedAt: true,
      },
    }),
  ]);

  const repoNameById = new Map(repos.map((r) => [r.id, r.fullName]));
  const currentIcla = versions.find(
    (v) => v.id === project.currentIclaVersionId,
  );
  const currentCcla = versions.find(
    (v) => v.id === project.currentCclaVersionId,
  );

  // Prior versions per kind (for the "require re-sign for earlier versions"
  // controls), newest first.
  const priorVersions = (kind: "ICLA" | "CCLA"): PriorVersion[] =>
    versions
      .filter((v) => v.kind === kind)
      .map((v) => ({
        id: v.id,
        version: v.version,
        resignRequired: v.resignRequired,
      }));

  const historyVersions: HistoryVersion[] = versions.map((v) => ({
    id: v.id,
    kind: v.kind,
    version: v.version,
    contentHash: v.contentHash,
    sourceType: v.sourceType,
    sourcePath: v.sourcePath,
    sourceRef: v.sourceRef,
    sourceCommitSha: v.sourceCommitSha,
    resignRequired: v.resignRequired,
    isCurrent:
      v.id === project.currentIclaVersionId ||
      v.id === project.currentCclaVersionId,
    publishedAt: v.publishedAt.toISOString(),
    repoFullName: v.sourceRepoId
      ? (repoNameById.get(v.sourceRepoId) ?? null)
      : null,
  }));

  const pendingItems: PendingItem[] = pending.map((p) => ({
    id: p.id,
    kind: p.kind as "ICLA" | "CCLA",
    sourcePath: p.sourcePath,
    sourceRef: p.sourceRef,
    detectedCommitSha: p.detectedCommitSha,
    detectedContent: p.detectedContent,
    detectedAt: p.detectedAt.toISOString(),
    currentVersionId:
      p.kind === "ICLA"
        ? project.currentIclaVersionId
        : project.currentCclaVersionId,
  }));

  return (
    <div className="space-y-6">
      {/* ----- CLA settings ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CLA settings</CardTitle>
          <CardDescription>
            Require contributors to sign a Contributor License Agreement before
            their PRs are accepted. Failing PRs stay open with a{" "}
            <code>cla-pending</code> label and a failing Check. They are never
            closed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateClaSettings} className="space-y-4">
            <input type="hidden" name="projectId" value={project.id} />
            {/* Preserve the repo-file source policy (edited in the Source card)
                so saving general settings doesn't reset it. */}
            {project.claAutoVersionRequiresResign && (
              <input
                type="hidden"
                name="claAutoVersionRequiresResign"
                value="1"
              />
            )}
            {project.claRepoFileReviewMode && (
              <input type="hidden" name="claRepoFileReviewMode" value="1" />
            )}

            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="claEnabled"
                value="1"
                defaultChecked={project.claEnabled}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">CLA enabled</span>
                <span className="block text-xs text-muted-foreground">
                  Turn on CLA processing for this project.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 pl-7 text-sm">
              <input
                type="checkbox"
                name="claRequired"
                value="1"
                defaultChecked={project.claRequired}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">Required (gate PRs)</span>
                <span className="block text-xs text-muted-foreground">
                  When off, signatures are recorded but a missing CLA never
                  blocks a PR or an application approval.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 pl-7 text-sm">
              <input
                type="checkbox"
                name="claCorporateEnabled"
                value="1"
                defaultChecked={project.claCorporateEnabled}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">Allow Corporate CLA</span>
                <span className="block text-xs text-muted-foreground">
                  A company signs once and maintains an employee roster; listed
                  contributors are covered.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 pl-14 text-sm">
              <input
                type="checkbox"
                name="claCorporateRequiresApproval"
                value="1"
                defaultChecked={project.claCorporateRequiresApproval}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">
                  Require admin approval to finalize a Corporate CLA
                </span>
                <span className="block text-xs text-muted-foreground">
                  A signed Corporate CLA stays pending and covers no one until
                  an admin approves it. Turn off to make new Corporate CLAs
                  effective immediately.
                </span>
              </span>
            </label>

            <div className="space-y-2 pl-7">
              <span className="text-sm font-medium">Placement</span>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  name="claPlacementEmbed"
                  value="1"
                  defaultChecked={project.claPlacementEmbed}
                  className="mt-0.5 h-4 w-4 rounded border-border"
                />
                <span>
                  <span className="font-medium">Embed in application</span>
                  <span className="block text-xs text-muted-foreground">
                    Add a CLA acceptance step to the application form.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  name="claPlacementStandalone"
                  value="1"
                  defaultChecked={project.claPlacementStandalone}
                  className="mt-0.5 h-4 w-4 rounded border-border"
                />
                <span>
                  <span className="font-medium">Standalone signing page</span>
                  <span className="block text-xs text-muted-foreground">
                    Expose a public signing page at{" "}
                    <code>/p/{project.slug}/cla</code>.
                  </span>
                </span>
              </label>
            </div>

            <label className="flex items-start gap-3 pl-7 text-sm">
              <input
                type="checkbox"
                name="claIclaRequireSignature"
                value="1"
                defaultChecked={project.claIclaRequireSignature}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">
                  Require a signature artifact for individual CLAs
                </span>
                <span className="block text-xs text-muted-foreground">
                  The signer&apos;s full legal name is always collected. With
                  this on, they must also provide a typed, drawn, or uploaded
                  signature; off = full legal name + &ldquo;I agree&rdquo;
                  checkbox. (Corporate CLAs always require the full signature
                  block.)
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="dcoEnabled"
                value="1"
                defaultChecked={project.dcoEnabled}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">Require DCO sign-off</span>
                <span className="block text-xs text-muted-foreground">
                  Independent of the CLA: every commit must carry a valid{" "}
                  <code>Signed-off-by:</code> trailer (
                  <code>git commit -s</code>
                  ).
                </span>
              </span>
            </label>

            <div className="space-y-2">
              <Label htmlFor="labelClaPending">CLA-pending label</Label>
              <Input
                id="labelClaPending"
                name="labelClaPending"
                defaultValue={project.labelClaPending}
              />
              <p className="text-xs text-muted-foreground">
                Applied to PRs that are otherwise approved but whose author has
                not satisfied the CLA/DCO gate.
              </p>
            </div>

            <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              Everyone except bypass-listed bots must sign, collaborators and
              manually-approved users included.
            </p>

            <SubmitButton>Save CLA settings</SubmitButton>
          </form>
        </CardContent>
      </Card>

      {/* ----- Notify unsigned applicants ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Notify unsigned applicants
          </CardTitle>
          <CardDescription>
            Remind applicants who have not signed the CLA (in-app and by email),
            and re-apply the CLA check to the open PRs of approved contributors.
            Covers submitted and approved applications, up to 200 per run.
            Reminders already sent (in the inbox or on a PR) are not repeated, so
            this is safe to run more than once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={notifyUnsignedApplicants}>
            <input type="hidden" name="projectId" value={project.id} />
            <SubmitButton
              variant="outline"
              disabled={
                !project.claEnabled ||
                !project.claRequired ||
                !project.currentIclaVersionId
              }
            >
              Notify unsigned applicants
            </SubmitButton>
            {(!project.claEnabled ||
              !project.claRequired ||
              !project.currentIclaVersionId) && (
              <p className="mt-2 text-xs text-muted-foreground">
                Enable and require the CLA and publish an ICLA version before
                sending reminders.
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      {/* ----- Source ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CLA source</CardTitle>
          <CardDescription>
            Publish a CLA version from pasted Markdown (using the editors below)
            or pull it from a file tracked in one of your repositories. Each
            published version is an immutable snapshot of the exact signed text.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form action={updateClaSettings} className="space-y-3">
            <input type="hidden" name="projectId" value={project.id} />
            {/* Preserve current CLA settings so this form only flips the
                auto-version policy. */}
            {project.claEnabled && (
              <input type="hidden" name="claEnabled" value="1" />
            )}
            {project.claRequired && (
              <input type="hidden" name="claRequired" value="1" />
            )}
            {project.claCorporateEnabled && (
              <input type="hidden" name="claCorporateEnabled" value="1" />
            )}
            {project.claCorporateRequiresApproval && (
              <input
                type="hidden"
                name="claCorporateRequiresApproval"
                value="1"
              />
            )}
            {project.claPlacementEmbed && (
              <input type="hidden" name="claPlacementEmbed" value="1" />
            )}
            {project.claPlacementStandalone && (
              <input type="hidden" name="claPlacementStandalone" value="1" />
            )}
            {project.dcoEnabled && (
              <input type="hidden" name="dcoEnabled" value="1" />
            )}
            {project.claIclaRequireSignature && (
              <input type="hidden" name="claIclaRequireSignature" value="1" />
            )}
            <input
              type="hidden"
              name="labelClaPending"
              value={project.labelClaPending}
            />
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="claRepoFileReviewMode"
                value="1"
                defaultChecked={project.claRepoFileReviewMode}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">
                  Review &amp; approve repo-file changes
                </span>
                <span className="block text-xs text-muted-foreground">
                  When a tracked CLA file changes on push (or you click Sync
                  now), queue it for review instead of auto-publishing. You then
                  approve it, choosing whether to require re-sign. Off =
                  auto-publish on change.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="claAutoVersionRequiresResign"
                value="1"
                defaultChecked={project.claAutoVersionRequiresResign}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">
                  Auto-published versions require re-sign
                </span>
                <span className="block text-xs text-muted-foreground">
                  When a change is auto-published (review mode off), force
                  everyone to re-sign. In review mode this only pre-fills the
                  approval default. Off = keep existing signatures valid.
                </span>
              </span>
            </label>
            <SubmitButton>Save repo-file policy</SubmitButton>
          </form>

          {/* Live source view + drift + manual sync, per repo-file kind. */}
          {currentIcla?.sourceType === "repo_file" && (
            <RepoSourcePanel
              projectId={project.id}
              kind="ICLA"
              label="Individual CLA"
            />
          )}
          {currentCcla?.sourceType === "repo_file" && (
            <RepoSourcePanel
              projectId={project.id}
              kind="CCLA"
              label="Corporate CLA"
            />
          )}

          <div className="space-y-3 rounded-md border border-dashed border-border p-4">
            <h4 className="text-sm font-medium">Publish from a repo file</h4>
            <p className="text-xs text-muted-foreground">
              Reads the file via the GitHub App installation, snapshots it as a
              new version, and records its commit SHA. The repository must have
              the App installed.
            </p>
            {repos.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No repositories are linked to this project yet.{" "}
                <Link
                  className="text-primary underline-offset-2 hover:underline"
                  href={`/dashboard/projects/${id}/repos`}
                >
                  Link a repo
                </Link>
                .
              </p>
            ) : (
              <RepoFilePublishForm
                projectId={project.id}
                repos={repos}
                iclaVersions={priorVersions("ICLA")}
                cclaVersions={priorVersions("CCLA")}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* ----- Repo-file changes to review (review mode) ----- */}
      <PendingChanges
        projectId={project.id}
        items={pendingItems}
        iclaVersions={priorVersions("ICLA")}
        cclaVersions={priorVersions("CCLA")}
      />

      {/* ----- ICLA editor ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Individual CLA (ICLA)</CardTitle>
          <CardDescription>
            Publish a new ICLA version from pasted Markdown. Individual
            contributors sign this version.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VersionEditor
            projectId={project.id}
            kind="ICLA"
            current={
              currentIcla
                ? {
                    version: currentIcla.version,
                    contentHash: currentIcla.contentHash,
                    sourceType: currentIcla.sourceType,
                  }
                : null
            }
            priorVersions={priorVersions("ICLA")}
          />
        </CardContent>
      </Card>

      {/* ----- CCLA editor ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Corporate CLA (CCLA)</CardTitle>
          <CardDescription>
            Publish a new CCLA version from pasted Markdown. A company signatory
            signs this version and maintains the employee roster.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VersionEditor
            projectId={project.id}
            kind="CCLA"
            current={
              currentCcla
                ? {
                    version: currentCcla.version,
                    contentHash: currentCcla.contentHash,
                    sourceType: currentCcla.sourceType,
                  }
                : null
            }
            priorVersions={priorVersions("CCLA")}
          />
        </CardContent>
      </Card>

      {/* ----- ICLA custom fields ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ICLA custom fields</CardTitle>
          <CardDescription>
            Extra fields collected from individual signers (e.g. mailing
            address, employer). Answers are stored immutably with each
            signature.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormBuilder
            projectId={project.id}
            initial={parseFormSchema(project.claIclaCustomFields)}
            action={saveIclaCustomFields}
            canEdit
          />
        </CardContent>
      </Card>

      {/* ----- CCLA custom fields ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CCLA custom fields</CardTitle>
          <CardDescription>
            Extra fields collected from the corporate signatory at signing time.
            Answers are stored immutably with the corporate signature.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormBuilder
            projectId={project.id}
            initial={parseFormSchema(project.claCclaCustomFields)}
            action={saveCclaCustomFields}
            canEdit
          />
        </CardContent>
      </Card>

      {/* ----- Version history ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Version history</CardTitle>
          <CardDescription>
            Every published version is retained immutably with its content hash.
            Expand a version to preview its text, and mark earlier versions as
            requiring a re-sign (for example a version published in error).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VersionHistory projectId={project.id} versions={historyVersions} />
        </CardContent>
      </Card>

      {/* ----- Related pages ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Signatures &amp; corporate
          </CardTitle>
          <CardDescription>
            Inspect the signature ledger, verify chain integrity, manage
            corporate agreements and rosters.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href={`/dashboard/projects/${id}/cla/signatures`}>
              Signature log &amp; waivers →
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/dashboard/projects/${id}/cla/corporate`}>
              Corporate CLAs &amp; rosters →
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
