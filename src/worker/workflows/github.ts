import {
  condition,
  continueAsNew,
  defineSignal,
  setHandler,
} from "@temporalio/workflow";
import { acts } from "./proxies";
import { SIG } from "../../lib/temporal/contracts";
import type {
  GithubEventEnvelope,
  ProcessPullRequestInput,
  ProcessMergeGroupInput,
  ProcessPushInput,
  ProcessInstallationInput,
} from "../../lib/temporal/contracts";

const githubEvent = defineSignal<[GithubEventEnvelope]>(SIG.githubEvent);

/** Continue-As-New once a busy PR has processed this many events, so a PR that
 * sees many `synchronize` events over its lifetime never approaches the 50k
 * history-event ceiling. */
const EVENTS_BEFORE_CONTINUE = 500;

/** How long to wait for the next event once the queue is drained before the
 * workflow COMPLETES. A later event simply signalWithStarts a fresh run. Keeps
 * a window open to batch rapid `synchronize` bursts without leaving a workflow
 * Running forever per PR. */
const IDLE_TIMEOUT = "1 minute";

/**
 * Short-lived entity workflow, one per (repo, PR). Every GitHub event for the PR
 * is delivered as a `githubEvent` signal (signalWithStart). Events are drained
 * in order and each runs the existing handler inside a durably-retried activity.
 * Once the PR goes quiet for IDLE_TIMEOUT the workflow completes; a busy PR
 * Continue-As-News at EVENTS_BEFORE_CONTINUE to bound history.
 */
export async function processPullRequest(
  input: ProcessPullRequestInput
): Promise<void> {
  const queue: GithubEventEnvelope[] = [input.first, ...(input.pending ?? [])];
  setHandler(githubEvent, (env) => {
    queue.push(env);
  });

  let processed = 0;
  while (processed < EVENTS_BEFORE_CONTINUE) {
    // Wait for work; if none arrives within the idle window, the PR is quiet —
    // complete the run. (A signal arriving during the wait flips the condition
    // true and we keep processing.)
    const hasWork = await condition(() => queue.length > 0, IDLE_TIMEOUT);
    if (!hasWork) return;
    // Run the existing handler in a durably-retried activity. Keep the event in
    // the queue until it succeeds so a Continue-As-New (or crash) never drops it.
    await acts.processPullRequestEvent(queue[0]);
    queue.shift();
    processed += 1;
  }

  // Hit the history-bound cap. Roll any remaining queued events into a fresh run
  // so history stays bounded; if the queue drained exactly at the cap, just
  // complete (a later event signalWithStarts a new run).
  if (queue.length > 0) {
    await continueAsNew<typeof processPullRequest>({
      repoId: input.repoId,
      prNumber: input.prNumber,
      first: queue[0],
      pending: queue.slice(1),
    });
  }
}

export async function processMergeGroup(
  input: ProcessMergeGroupInput
): Promise<void> {
  await acts.processMergeGroupEvent(input.payload);
}

export async function processPush(input: ProcessPushInput): Promise<void> {
  await acts.processPushEvent(input.payload);
}

export async function processInstallation(
  input: ProcessInstallationInput
): Promise<void> {
  await acts.processInstallationEvent(input.kind, input.payload);
}
