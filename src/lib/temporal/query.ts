import "server-only";
import { WorkflowNotFoundError } from "@temporalio/client";
import { getTemporalClient } from "./client";
import { workflowIds } from "./task-queue";
import { QRY } from "./contracts";
import type {
  ContributorGateState,
  PrGateState,
  ProjectGateState,
} from "./contracts";

/**
 * Typed read access to the entity workflows' query handlers, kept separate
 * from start.ts (the mutation surface). Returns null when no execution exists
 * for the deterministic id (never started, or the id has no runs), so callers
 * get a clean "no live gate" instead of a throw. A query against a COMPLETED
 * run returns its final state, which is exactly the entity semantics the
 * deterministic ids give us.
 */
async function queryById<T>(
  workflowId: string,
  queryName: string
): Promise<T | null> {
  const client = await getTemporalClient();
  try {
    return await client.workflow.getHandle(workflowId).query<T, []>(queryName);
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) return null;
    throw e;
  }
}

export function queryPrGateState(
  repoId: string,
  prNumber: number
): Promise<PrGateState | null> {
  return queryById<PrGateState>(
    workflowIds.pullRequest(repoId, prNumber),
    QRY.prGateState
  );
}

export function queryContributorGateState(
  projectId: string,
  authorGhId: number
): Promise<ContributorGateState | null> {
  return queryById<ContributorGateState>(
    workflowIds.contributor(projectId, authorGhId),
    QRY.contributorGateState
  );
}

export function queryProjectGateState(
  projectId: string
): Promise<ProjectGateState | null> {
  return queryById<ProjectGateState>(
    workflowIds.project(projectId),
    QRY.projectGateState
  );
}
