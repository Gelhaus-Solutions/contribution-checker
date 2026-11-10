import { acts } from "./proxies";
import { convergeWhenGmintAnswers } from "./gmint-wait";
import { PATCHES } from "../../lib/temporal/contracts";
import type {
  ProcessMergeGroupInput,
  ProcessPushInput,
  ProcessInstallationInput,
} from "../../lib/temporal/contracts";

/** A merge group's commit is reported on only until the queue's check timeout
 * removes the entry; checks published after that land on a commit nobody
 * reads. */
const MERGE_GROUP_GMINT_WAIT_MS = 6 * 60 * 60 * 1000;

export async function processMergeGroup(
  input: ProcessMergeGroupInput
): Promise<void> {
  await convergeWhenGmintAnswers(
    () => acts.processMergeGroupEvent(input.payload),
    PATCHES.gmintWait,
    MERGE_GROUP_GMINT_WAIT_MS,
  );
}

export async function processPush(input: ProcessPushInput): Promise<void> {
  await convergeWhenGmintAnswers(
    () => acts.processPushEvent(input.payload),
    PATCHES.gmintWait,
  );
}

export async function processInstallation(
  input: ProcessInstallationInput
): Promise<void> {
  await acts.processInstallationEvent(input.kind, input.payload);
}
