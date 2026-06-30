import { acts } from "./proxies";
import type {
  CiCheckPrInput,
  CiReconcileInput,
  CiCoreResult,
} from "../../lib/temporal/contracts";

/**
 * CI mode wrapped in workflows: the route starts + awaits these so the GitHub
 * Action gets its answer, while the decision/quality work runs durably (and is
 * retried on transient DB/GitHub hiccups instead of failing the Action).
 */
export async function ciCheckPr(input: CiCheckPrInput): Promise<CiCoreResult> {
  return acts.runCiCheckPr({ body: input.body, claims: input.claims });
}

export async function ciReconcile(
  input: CiReconcileInput
): Promise<CiCoreResult> {
  return acts.runCiReconcile({ body: input.body, claims: input.claims });
}
