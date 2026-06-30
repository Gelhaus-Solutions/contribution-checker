import { acts } from "./proxies";
import type {
  ProcessMergeGroupInput,
  ProcessPushInput,
  ProcessInstallationInput,
} from "../../lib/temporal/contracts";

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
