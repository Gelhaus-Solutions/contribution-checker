"use client";

import { Badge } from "@/components/ui/badge";

export type PriorVersion = {
  id: string;
  version: number;
  resignRequired: boolean;
};

/**
 * Checkbox list of a kind's existing versions, posted as repeated
 * `resignVersionIds`. Checking a version marks signatures on it stale (re-sign
 * required) when the new version publishes. Versions already requiring re-sign
 * are shown checked + disabled (publishing can only add re-sign, not lift it;
 * use Version history to lift it). Renders nothing when there are no prior
 * versions.
 */
export function PriorVersionResignList({
  versions,
  idPrefix,
}: {
  versions: PriorVersion[];
  idPrefix: string;
}) {
  if (versions.length === 0) return null;
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">
        Require re-sign for earlier versions
      </legend>
      <p className="text-xs text-muted-foreground">
        Check a version to invalidate signatures made against it (for example a
        version published in error). Unchecked versions stay valid.
      </p>
      <div className="flex flex-wrap gap-3">
        {versions.map((v) => {
          const inputId = `${idPrefix}-resign-${v.id}`;
          return (
            <label
              key={v.id}
              htmlFor={inputId}
              className="flex items-center gap-2 text-xs"
            >
              <input
                id={inputId}
                type="checkbox"
                name="resignVersionIds"
                value={v.id}
                defaultChecked={v.resignRequired}
                disabled={v.resignRequired}
                className="h-4 w-4 rounded border-border"
              />
              <span className="font-medium">v{v.version}</span>
              {v.resignRequired && (
                <Badge variant="warning">already requires re-sign</Badge>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
