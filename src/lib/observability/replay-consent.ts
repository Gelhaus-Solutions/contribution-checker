import * as Sentry from "@sentry/nextjs";

/**
 * Session replay runs only for a visitor who has said yes.
 *
 * Recording a visit and keeping the replay's session id in session storage is
 * access to the visitor's device (Section 25 TDDDG, Art. 5(3) ePrivacy
 * Directive), and finding our own bugs is not something the visitor asked for,
 * so it needs consent. The operator decided so on 2026-10-04, replacing the
 * unconsented recording of every visit decided on 2026-10-02. What did not
 * change: a replay, once allowed, is unmasked and covers the whole visit,
 * because a masked one cannot show what went wrong on a form.
 *
 * The choice itself is kept in local storage. Remembering a "no" is what stops
 * the question coming back on every page, which makes storing it strictly
 * necessary rather than another thing to ask about.
 */

export const REPLAY_CONSENT_KEY = "cc.replay-consent";

/** Fired on window to show the question again (the "Session recording" links). */
export const REPLAY_CONSENT_EVENT = "cc:replay-consent";

export type ReplayChoice = "granted" | "denied";

/** The stored choice, or null when none was made or storage is unavailable. */
export function readReplayChoice(storage: Storage | undefined = safeLocalStorage()): ReplayChoice | null {
  try {
    const value = storage?.getItem(REPLAY_CONSENT_KEY);
    return value === "granted" || value === "denied" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Store the choice and act on it at once: a yes starts recording from this
 * page, a no stops a recording that is running and drops its session.
 */
export async function saveReplayChoice(
  choice: ReplayChoice,
  storage: Storage | undefined = safeLocalStorage(),
): Promise<void> {
  try {
    storage?.setItem(REPLAY_CONSENT_KEY, choice);
  } catch {
    // Private mode or a full quota: the choice still applies to this page.
  }
  if (choice === "granted") startReplay();
  else await stopReplay();
}

/** Start recording, adding the integration the first time. No Sentry, no-op. */
export function startReplay(): void {
  if (!Sentry.getClient() || !hasReplayApi()) return;
  const replay = Sentry.getReplay();
  if (replay) {
    replay.start();
    return;
  }
  Sentry.addIntegration(
    Sentry.replayIntegration({
      maskAllText: false,
      blockAllMedia: false,
      maskAllInputs: false,
    }),
  );
}

export async function stopReplay(): Promise<void> {
  if (!hasReplayApi()) return;
  await Sentry.getReplay()?.stop();
}

/**
 * Replay exists only in the browser build of the SDK. Under Node (the unit
 * tests, a server import) `getReplay` is simply absent.
 */
function hasReplayApi(): boolean {
  return typeof (Sentry as { getReplay?: unknown }).getReplay === "function";
}

/** Show the question again, with the current choice preselected in the text. */
export function reopenReplayChoice(): void {
  window.dispatchEvent(new Event(REPLAY_CONSENT_EVENT));
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
