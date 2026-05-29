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
import { Badge } from "@/components/ui/badge";
import { FormBuilder } from "../form/builder";
import { parseFormSchema } from "@/lib/applications/schema";
import { VersionEditor } from "./version-editor";
import {
  updateClaSettings,
  publishClaVersion,
  saveIclaCustomFields,
  saveCclaCustomFields,
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

  const [repos, versions] = await Promise.all([
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
        requireResign: true,
        publishedAt: true,
      },
    }),
  ]);

  const currentIcla = versions.find(
    (v) => v.id === project.currentIclaVersionId
  );
  const currentCcla = versions.find(
    (v) => v.id === project.currentCclaVersionId
  );

  return (
    <div className="space-y-6">
      {/* ----- CLA settings ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CLA settings</CardTitle>
          <CardDescription>
            Require contributors to sign a Contributor License Agreement before
            their PRs are accepted. Failing PRs stay open with a{" "}
            <code>cla-pending</code> label and a failing Check &mdash; they are
            never closed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateClaSettings} className="space-y-4">
            <input type="hidden" name="projectId" value={project.id} />

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
                  Require a typed signature for individual CLAs
                </span>
                <span className="block text-xs text-muted-foreground">
                  Contributors must type their full legal name to sign. When off,
                  the &ldquo;I agree&rdquo; checkbox alone is a valid individual
                  click-wrap. (Corporate CLAs always require the full signature
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
                  <code>Signed-off-by:</code> trailer (<code>git commit -s</code>
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
              Everyone except bypass-listed bots must sign &mdash; collaborators
              and manually-approved users included.
            </p>

            <SubmitButton>Save CLA settings</SubmitButton>
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
                name="claAutoVersionRequiresResign"
                value="1"
                defaultChecked={project.claAutoVersionRequiresResign}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              <span>
                <span className="font-medium">
                  Repo-file auto-versions require re-sign
                </span>
                <span className="block text-xs text-muted-foreground">
                  When a tracked CLA file changes on push and a new version is
                  auto-published, force everyone to re-sign. Off = keep existing
                  signatures valid.
                </span>
              </span>
            </label>
            <SubmitButton>Save auto-version policy</SubmitButton>
          </form>

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
              <form
                action={publishClaVersion}
                className="grid grid-cols-1 gap-3 md:grid-cols-2"
              >
                <input type="hidden" name="projectId" value={project.id} />
                <input type="hidden" name="sourceType" value="repo_file" />
                <div className="space-y-1">
                  <Label htmlFor="rf-kind">Agreement</Label>
                  <select
                    id="rf-kind"
                    name="kind"
                    defaultValue="ICLA"
                    className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
                  >
                    <option value="ICLA">Individual (ICLA)</option>
                    <option value="CCLA">Corporate (CCLA)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rf-repo">Repository</Label>
                  <select
                    id="rf-repo"
                    name="sourceRepoId"
                    className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
                  >
                    {repos.map((r) => (
                      <option
                        key={r.id}
                        value={r.id}
                        disabled={!r.installationId}
                      >
                        {r.fullName}
                        {r.installationId ? "" : " (App not installed)"}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rf-path">File path</Label>
                  <Input
                    id="rf-path"
                    name="sourcePath"
                    defaultValue="CLA.md"
                    placeholder="CLA.md"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rf-ref">Ref (optional)</Label>
                  <Input
                    id="rf-ref"
                    name="sourceRef"
                    placeholder="(default branch)"
                  />
                </div>
                <label className="flex items-start gap-3 text-sm md:col-span-2">
                  <input
                    type="checkbox"
                    name="requireResign"
                    value="1"
                    className="mt-0.5 h-4 w-4 rounded border-border"
                  />
                  <span>
                    <span className="font-medium">Require re-sign</span>
                    <span className="block text-xs text-muted-foreground">
                      Invalidates prior signatures of this kind.
                    </span>
                  </span>
                </label>
                <div className="md:col-span-2">
                  <SubmitButton size="sm">Fetch &amp; publish</SubmitButton>
                </div>
              </form>
            )}
          </div>
        </CardContent>
      </Card>

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
          />
        </CardContent>
      </Card>

      {/* ----- ICLA custom fields ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ICLA custom fields</CardTitle>
          <CardDescription>
            Extra fields collected from individual signers (e.g. mailing
            address, employer). Answers are stored immutably with each signature.
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
          </CardDescription>
        </CardHeader>
        <CardContent>
          {versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No versions have been published yet.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {versions.map((v) => {
                const isCurrent =
                  v.id === project.currentIclaVersionId ||
                  v.id === project.currentCclaVersionId;
                return (
                  <li
                    key={v.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{v.kind}</Badge>
                      <span className="font-medium">v{v.version}</span>
                      <span className="font-mono text-muted-foreground">
                        {v.contentHash.slice(0, 12)}
                      </span>
                      <span className="text-muted-foreground">
                        {v.sourceType}
                      </span>
                      {v.requireResign && (
                        <Badge variant="warning">required re-sign</Badge>
                      )}
                      {isCurrent && <Badge variant="success">current</Badge>}
                    </div>
                    <span className="text-muted-foreground">
                      {v.publishedAt
                        .toISOString()
                        .replace("T", " ")
                        .slice(0, 16)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ----- Related pages ----- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Signatures &amp; corporate</CardTitle>
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
