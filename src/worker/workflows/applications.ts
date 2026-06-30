import { sleep } from "@temporalio/workflow";
import { acts } from "./proxies";
import type {
  ApplicationDecisionInput,
  ApplicationDecisionResult,
  CooldownTimerInput,
  ClaStalenessTimerInput,
} from "../../lib/temporal/contracts";

/**
 * Run an application decision's GitHub fan-out (reopen-all / close-all /
 * relabel) durably. Started + awaited by the admin server action so the
 * dashboard still shows the final count.
 */
export async function applicationDecision(
  input: ApplicationDecisionInput
): Promise<ApplicationDecisionResult> {
  return acts.runApplicationPostDecision(input);
}

/**
 * Durable cooldown timer. Sleeps until the cooldown elapses, then enables
 * resubmission and notifies the applicant. Replaces re-deriving "cooldown
 * elapsed?" on every PR decision: the moment it expires, the applicant is told.
 * A single sleep + one activity = a tiny history even across a months-long wait.
 */
export async function applicationCooldownTimer(
  input: CooldownTimerInput
): Promise<void> {
  const target = Date.parse(input.cooldownUntilIso);
  const delay = target - Date.now();
  if (delay > 0) await sleep(delay);
  await acts.elapseApplicationCooldown(input.applicationId);
}

/**
 * Durable CLA-staleness re-check timer. Same shape as the cooldown timer: sleep
 * until the recheck time, then re-run the unsigned-applicant sweep for the
 * affected project so a now-stale signer is re-gated promptly.
 */
export async function claStalenessTimer(
  input: ClaStalenessTimerInput
): Promise<void> {
  const target = Date.parse(input.recheckAtIso);
  const delay = target - Date.now();
  if (delay > 0) await sleep(delay);
  await acts.claSweepProject(input.projectId);
}
