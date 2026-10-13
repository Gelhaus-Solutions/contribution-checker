import { reportDecoyInventory } from "@/lib/lockdown";
import { logger } from "@/lib/logger";

/**
 * Tells GLockdown which decoys this app checks (src/lib/lockdown.ts), as
 * hashes only. Never throws: the outcome is audited there and returned here,
 * so it reads from the workflow's history when the logs are gone.
 */
export async function reportGlockdownDecoys(): Promise<{ ok: boolean; code: string | null }> {
  const r = await reportDecoyInventory("daily");
  if (!r.ok && r.code === "not_configured") {
    logger.info({ detail: r.detail }, "lockdown: decoys not reported, GLockdown's edge is not configured");
  }
  return { ok: r.ok, code: r.ok ? null : r.code };
}
