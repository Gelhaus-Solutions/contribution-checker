import {
  computeCiCheckPr,
  type CiCheckPrBody,
  type GhActionsClaims,
} from "@/lib/ci/check-pr-core";
import {
  computeCiReconcile,
  type CiReconcileBody,
} from "@/lib/ci/reconcile-core";
import type { CiCoreResult } from "@/lib/temporal/contracts";

/** Activity wrappers around the extracted CI cores. The route verifies the OIDC
 * token (HTTP edge) and passes the validated body + claims here. */
export async function runCiCheckPr(input: {
  body: unknown;
  claims: unknown;
}): Promise<CiCoreResult> {
  return computeCiCheckPr({
    body: input.body as CiCheckPrBody,
    claims: input.claims as GhActionsClaims,
  });
}

export async function runCiReconcile(input: {
  body: unknown;
  claims: unknown;
}): Promise<CiCoreResult> {
  return computeCiReconcile({
    body: input.body as CiReconcileBody,
    claims: input.claims as GhActionsClaims,
  });
}
