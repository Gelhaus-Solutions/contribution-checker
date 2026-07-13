import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { ensureSearchAttributes } from "@/lib/temporal/search-attribute-registration";

/**
 * Register the app's custom Search Attributes on an ephemeral test server.
 * The gate workflows upsert them (RepoId/GateStatus/...), and an upsert
 * against an attribute the namespace doesn't know fails the workflow task
 * forever (the same reason the worker self-registers them on startup, see
 * src/worker/run.ts). The time-skipping server implements addSearchAttributes
 * but NOT listSearchAttributes, so ensureSearchAttributes falls back to blind
 * per-attribute adds; a fresh server has none, so the adds never conflict.
 */
export async function registerTestSearchAttributes(
  env: TestWorkflowEnvironment
): Promise<void> {
  await ensureSearchAttributes(env.connection.operatorService, "default");
}
