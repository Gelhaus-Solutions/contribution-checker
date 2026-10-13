"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/authz";
import {
  lockdownStatus,
  raiseOneRung,
  refreshFromEdge,
  reportDecoyInventory,
} from "@/lib/lockdown";
import { rateLimit } from "@/lib/ratelimit";

export type LockdownActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

const PATH = "/admin/lockdown";

/** GLockdown's refusal in one line: its code, what it added, and the HTTP status when there was one. */
function refusal(r: { code: string; status: number; detail?: string | null }): string {
  const detail = r.detail ? ` (${r.detail})` : "";
  const status = r.status ? `, HTTP ${r.status}` : "";
  return `${r.code}${detail}${status}`;
}

/**
 * Asks GLockdown to raise this app one rung (src/lib/lockdown.ts). The form
 * carries the rung it was rendered at, and the raise goes out only while the
 * stage still stands there: a raise is one rung from where the stage is, so a
 * second submit of the same form, or a form left open while the stage moved,
 * must not raise a second rung. `raiseOneRung` refuses an overlapping raise in
 * this process; the rate limit covers the other replicas.
 */
export async function raiseOneRungAction(
  _prev: LockdownActionState,
  formData: FormData,
): Promise<LockdownActionState> {
  const session = await requireSuperAdmin();
  const reason = String(formData.get("reason") ?? "").trim();
  const from = String(formData.get("from") ?? "");
  if (formData.get("understood") !== "on") {
    return { status: "error", message: "Confirm that only GLockdown can lower the stage again." };
  }
  if (reason.length < 3) {
    return { status: "error", message: "Say why. GLockdown records the reason with the raise." };
  }

  await refreshFromEdge();
  const now = lockdownStatus().rung;
  if (from !== now) {
    revalidatePath(PATH);
    return {
      status: "error",
      message: `GLockdown's rung moved to ${now} since this page loaded. Nothing was sent; look again and decide.`,
    };
  }
  const limited = await rateLimit({ key: "glockdown:raise", limit: 1, windowMs: 30_000 });
  if (!limited.ok) {
    return {
      status: "error",
      message: "A raise went out in the last 30 seconds. Nothing was sent; reload to see where the stage stands.",
    };
  }

  const r = await raiseOneRung({ reason, actorId: session.user.id, via: "console" });
  revalidatePath(PATH);
  if (!r.ok) return { status: "error", message: `GLockdown did not raise it: ${refusal(r)}.` };
  const after = lockdownStatus().rung;
  return {
    status: "ok",
    message:
      after !== r.from
        ? `Raised from ${r.from} to ${after}.`
        : `GLockdown accepted the raise from ${r.from}; the edge will report the new rung within seconds.`,
  };
}

/** Tells GLockdown which decoys this app checks, now rather than at the next daily run. */
export async function reportDecoysAction(
  _prev: LockdownActionState,
  _formData: FormData,
): Promise<LockdownActionState> {
  const session = await requireSuperAdmin();
  const r = await reportDecoyInventory("console", session.user.id);
  revalidatePath(PATH);
  return r.ok
    ? { status: "ok", message: "GLockdown has this app's decoy inventory." }
    : { status: "error", message: `The report did not go through: ${refusal(r)}.` };
}
