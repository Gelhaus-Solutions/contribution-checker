import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { SEARCH_ATTRIBUTE_REGISTRATIONS } from "@/lib/temporal/search-attributes";

/** temporal.api.enums.v1.IndexedValueType, mirrored from the registration
 * script (scripts/register-search-attributes.ts). */
const INDEXED_VALUE_TYPE: Record<string, number> = {
  TEXT: 1,
  KEYWORD: 2,
  INT: 3,
  DOUBLE: 4,
  BOOL: 5,
  DATETIME: 6,
  KEYWORD_LIST: 7,
};

/**
 * Register the app's custom Search Attributes on an ephemeral test server.
 * The gate workflows upsert them (RepoId/PrNumber/GateStatus/...), and an
 * upsert against an attribute the namespace doesn't know fails the workflow
 * task forever (the same reason prod runs `pnpm temporal:register-sa` before
 * deploying workers). The time-skipping server implements
 * addSearchAttributes but NOT listSearchAttributes, so this registers blindly;
 * a fresh server has none, so the add never conflicts.
 */
export async function registerTestSearchAttributes(
  env: TestWorkflowEnvironment
): Promise<void> {
  await env.connection.operatorService.addSearchAttributes({
    namespace: "default",
    searchAttributes: Object.fromEntries(
      SEARCH_ATTRIBUTE_REGISTRATIONS.map((r) => [
        r.name,
        INDEXED_VALUE_TYPE[r.type],
      ])
    ),
  });
}
