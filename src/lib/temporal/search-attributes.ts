import {
  defineSearchAttributeKey,
  SearchAttributeType,
} from "@temporalio/common";

/**
 * Typed custom Search Attribute keys, shared by workflows
 * (upsertSearchAttributes on state transitions), the client (typed attributes
 * at start so an execution is findable before its first task), and the
 * registration script. Import-light: only @temporalio/common, so this module
 * is safe inside the deterministic workflow bundle.
 *
 * The attribute names MUST be registered on the namespace before any worker
 * upserts them (run `pnpm temporal:register-sa`, see
 * scripts/register-search-attributes.ts); an upsert against an unregistered
 * attribute fails the workflow task at runtime.
 */
export const SA = {
  /** Project the execution belongs to (contributorGate, projectGate). */
  ProjectId: defineSearchAttributeKey("ProjectId", SearchAttributeType.KEYWORD),
  /** GitHub repo id (all prGate executions for a repo). INT: it is numeric,
   * and SQL-visibility namespaces cap custom attributes per type (a shared
   * dev "default" namespace runs close to those caps). A single PR's gate
   * needs no attribute at all: its workflow id `pr:{repoId}:{prNumber}` is
   * deterministic. A PrNumber attribute is deliberately omitted for the same
   * reason (a cross-repo PR-number filter carries no signal). */
  RepoId: defineSearchAttributeKey("RepoId", SearchAttributeType.INT),
  ContributorGhId: defineSearchAttributeKey(
    "ContributorGhId",
    SearchAttributeType.INT
  ),
  /** Entity lifecycle: active | idle | terminal | continued. */
  GateStatus: defineSearchAttributeKey(
    "GateStatus",
    SearchAttributeType.KEYWORD
  ),
} as const;

/** GateStatus values, kept as a union so workflows can't typo one. */
export type GateStatusValue = "active" | "idle" | "terminal" | "continued";

/** Name -> type descriptors consumed by the registration script (which diffs
 * them against the namespace and adds only the missing ones). Derived from SA
 * so the two can never drift. */
export const SEARCH_ATTRIBUTE_REGISTRATIONS: ReadonlyArray<{
  name: string;
  type: SearchAttributeType;
}> = Object.values(SA).map((key) => ({ name: key.name, type: key.type }));
