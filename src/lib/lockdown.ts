import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GlockdownStage,
  strictest,
  type EdgeConnection,
  type Stage,
} from "@ghub/glockdown-sdk";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * GLockdown's kill switch for this app, in five stages, each refusing what the
 * one before refused and more:
 *
 * - `off`: nothing.
 * - `signups`: no new accounts. Everyone who has one signs in as usual.
 * - `members`: only super-admins and project members (OWNER, ADMIN,
 *   REVIEWER) sign in; applicants are refused.
 * - `admins`: only super-admins.
 * - `full`: nobody, existing sessions included, and the sign-in pages send
 *   people to the home page.
 *
 * From AAL phase 2 the bot stops too: the GitHub webhook and the CI check
 * answer 503, so no pull request is gated or touched while it holds. Below
 * that, GitHub's signed webhooks, the CI check (OIDC) and the public pages work
 * at every stage, so pull requests are not left stuck.
 *
 * The stage is the STRICTEST of three sources, and none can lower another:
 * `CC_LOCKDOWN` in the environment (a floor nothing in the app lowers), the
 * stage file the GLockdown agent on this host writes
 * (`/run/glockdown/apps/contribution-checker.json`, mounted read-only), and
 * GLockdown's edge, asked over this app's own pinned TLS identity
 * (`@ghub/glockdown-sdk`). The file and the edge each keep their last good
 * answer while silent, so a file deleted, blocked or rewritten on the host does
 * not unlock the app while the edge still says otherwise.
 *
 * Who may sign in is decided in `auth()` (src/auth.ts), where every session is
 * resolved; `requireSession()` sends a person the switch refused to the home
 * page instead of back to the sign-in loop.
 */

/** This app's name in GLockdown's scopes and the agent's configuration. */
export const GLOCKDOWN_APP = "contribution-checker";

/** From AAL phase 2 the bot stops too. */
const BOT_STOPS = new Set(["aal2", "sil", "ail"]);

let source: GlockdownStage | null = null;

function edgeConnection(): EdgeConnection | undefined {
  if (!env.GLOCKDOWN_EDGE_URL || !env.GLOCKDOWN_EDGE_PINS) return undefined;
  try {
    return {
      url: env.GLOCKDOWN_EDGE_URL,
      edgePins: env.GLOCKDOWN_EDGE_PINS.split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      cert: readFileSync(join(env.GLOCKDOWN_IDENTITY_DIR, "tls.crt"), "utf8"),
      key: readFileSync(join(env.GLOCKDOWN_IDENTITY_DIR, "tls.key"), "utf8"),
    };
  } catch (e) {
    // The file still counts; the edge is asked once the identity is mounted.
    logger.warn(
      { err: e },
      "lockdown: no GLockdown identity, the edge is not asked",
    );
    return undefined;
  }
}

function glockdown(): GlockdownStage {
  if (source) return source;
  const edge = edgeConnection();
  source = new GlockdownStage({
    app: GLOCKDOWN_APP,
    dir: env.GLOCKDOWN_STAGE_DIR,
    ...(edge ? { edge } : {}),
  });
  return source;
}

export interface Lockdown {
  stage: Stage;
  /** GLockdown's rung behind it (`aal`, `aal2`...), when GLockdown set it. */
  rung: string | null;
}

/** The stage now; cheap enough for every request. */
export function lockdown(): Lockdown {
  const r = glockdown().reading();
  return { stage: strictest(r.stage, env.CC_LOCKDOWN), rung: r.rung };
}

/** Whether the bot stops: GitHub's webhook and the CI check answer 503 (AAL phase 2 and up). */
export function botStopped(): boolean {
  const { rung } = lockdown();
  return rung !== null && BOT_STOPS.has(rung);
}

/** For tests: forget the source, so the next call reads the environment again. */
export function resetLockdownForTests(): void {
  source = null;
}
