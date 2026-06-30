import {
  condition,
  continueAsNew,
  defineSignal,
  setHandler,
  workflowInfo,
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

/**
 * Long-lived entity workflow, one per (repo, PR). Every GitHub event for the PR
 * is delivered as a `githubEvent` signal (signalWithStart). Events are drained
 * in order and each runs the existing handler inside a durably-retried activity.
 * When enough events have been processed, Continue-As-New resets history,
 * carrying any not-yet-drained signals forward.
 */
export async function processPullRequest(
  input: ProcessPullRequestInput
): Promise<void> {
  const queue: GithubEventEnvelope[] = [input.first, ...(input.pending ?? [])];
  setHandler(githubEvent, (env) => {
    queue.push(env);
  });

  const rollOver = async (): Promise<never> => {
    await continueAsNew<typeof processPullRequest>({
      repoId: input.repoId,
      prNumber: input.prNumber,
      first: queue[0],
      pending: queue.slice(1),
    });
    // continueAsNew throws to end the run; this is unreachable.
    throw new Error("unreachable");
  };

  let processed = 0;
  while (processed < EVENTS_BEFORE_CONTINUE) {
    await condition(() => queue.length > 0);
    // Run the existing handler in a durably-retried activity. Keep the event in
    // the queue until it succeeds so a Continue-As-New (or crash) never drops it.
    await acts.processPullRequestEvent(queue[0]);
    queue.shift();
    processed += 1;
  }

  // Hit the history-bound cap. If more work is queued, roll it forward; else do
  // a short final wait to avoid a lost-signal race, then complete (a new event
  // later will signalWithStart a fresh execution).
  if (queue.length > 0) await rollOver();
  if (await condition(() => queue.length > 0, "1 second")) await rollOver();
  void workflowInfo();
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
