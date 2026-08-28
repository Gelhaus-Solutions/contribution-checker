import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { AiRunInput, AiRunResultPayload } from "../../lib/temporal/contracts";

/**
 * One AI task run.
 *
 * A dedicated proxy rather than the shared `acts` one, because the default
 * policy (10 minute start-to-close, 8 attempts, exponential backoff) is wrong
 * for a paid API call in two directions at once. Eight attempts against a model
 * that is answering but answering badly is eight times the money for the same
 * wrong answer, and ten minutes is far longer than any call we make: the client
 * already aborts at AI_REQUEST_TIMEOUT_MS, so a longer ceiling only delays the
 * retry.
 *
 * Three attempts covers the failure this actually sees, which is a provider 503
 * spike (observed against Gemini during development, cleared within seconds).
 * Anything the activity considers terminal, it reports rather than throws, so
 * those cost exactly one attempt regardless of this policy.
 */
const aiActs = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    // A run that failed validation or ran out of credit must not be retried:
    // the same prompt on the same model produces the same result, and paying
    // three times to learn that is the exact waste this subsystem avoids.
    nonRetryableErrorTypes: ["AiTerminalError"],
  },
});

export async function aiRun(input: AiRunInput): Promise<AiRunResultPayload> {
  return aiActs.runAiTaskActivity(input);
}
