"use client";

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Markdown } from "@/components/markdown";
import { Select } from "@/components/ui/select";
import { publishClaVersion, previewRepoFile } from "./actions";
import {
  PriorVersionResignList,
  type PriorVersion,
} from "./prior-version-resign-list";

type Repo = { id: string; fullName: string; installationId: number | null };

/**
 * Publish a CLA version from a repo file, with a "Preview file" button that
 * fetches and renders the file before publishing. The actual publish re-fetches
 * server-side for integrity. Prior versions can be marked re-sign-required.
 */
export function RepoFilePublishForm({
  projectId,
  repos,
  iclaVersions,
  cclaVersions,
}: {
  projectId: string;
  repos: Repo[];
  iclaVersions: PriorVersion[];
  cclaVersions: PriorVersion[];
}) {
  const [kind, setKind] = useState<"ICLA" | "CCLA">("ICLA");
  const [sourceRepoId, setSourceRepoId] = useState(
    repos.find((r) => r.installationId)?.id ?? repos[0]?.id ?? ""
  );
  const [path, setPath] = useState("CLA.md");
  const [ref, setRef] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();

  function onPreview() {
    setError(null);
    setPreview(null);
    startPreview(async () => {
      const res = await previewRepoFile({
        projectId,
        sourceRepoId,
        path,
        ref: ref.trim() || null,
      });
      if (res.ok) setPreview(res.content);
      else setError(res.error);
    });
  }

  const priorVersions = kind === "ICLA" ? iclaVersions : cclaVersions;

  return (
    <form
      action={publishClaVersion}
      className="grid grid-cols-1 gap-3 md:grid-cols-2"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="sourceType" value="repo_file" />

      <div className="space-y-1">
        <Label htmlFor="rf-kind">Agreement</Label>
        <Select
          id="rf-kind"
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as "ICLA" | "CCLA")}
        >
          <option value="ICLA">Individual (ICLA)</option>
          <option value="CCLA">Corporate (CCLA)</option>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="rf-repo">Repository</Label>
        <Select
          id="rf-repo"
          name="sourceRepoId"
          value={sourceRepoId}
          onChange={(e) => setSourceRepoId(e.target.value)}
        >
          {repos.map((r) => (
            <option key={r.id} value={r.id} disabled={!r.installationId}>
              {r.fullName}
              {r.installationId ? "" : " (App not installed)"}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="rf-path">File path</Label>
        <Input
          id="rf-path"
          name="sourcePath"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="CLA.md"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="rf-ref">Ref (optional)</Label>
        <Input
          id="rf-ref"
          name="sourceRef"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="(default branch)"
        />
      </div>

      <div className="md:col-span-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={previewing}
          onClick={onPreview}
          disabled={!sourceRepoId || !path.trim()}
        >
          Preview file
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive md:col-span-2">{error}</p>
      )}
      {preview !== null && (
        <div className="md:col-span-2 max-h-[24rem] overflow-y-auto rounded-md border border-border bg-background p-3">
          {preview.trim() ? (
            <Markdown source={preview} />
          ) : (
            <p className="text-sm text-muted-foreground">The file is empty.</p>
          )}
        </div>
      )}

      <div className="md:col-span-2">
        <PriorVersionResignList versions={priorVersions} idPrefix={`rf-${kind}`} />
      </div>

      <label className="flex items-start gap-3 text-sm md:col-span-2">
        <input
          type="checkbox"
          name="requireResign"
          value="1"
          className="mt-0.5 h-4 w-4 rounded border-border"
        />
        <span>
          <span className="font-medium">Require re-sign for all earlier versions</span>
          <span className="block text-xs text-muted-foreground">
            Invalidates every prior signature of this kind. Leave off to keep
            existing signatures valid (or pick specific versions above).
          </span>
        </span>
      </label>
      <div className="md:col-span-2">
        <SubmitButton size="sm">Fetch &amp; publish</SubmitButton>
      </div>
    </form>
  );
}
