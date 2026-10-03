"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  readReplayChoice,
  REPLAY_CONSENT_EVENT,
  saveReplayChoice,
  type ReplayChoice,
} from "@/lib/observability/replay-consent";

/**
 * The question that has to be answered before a visit is recorded.
 *
 * Shown once, at the foot of whatever page somebody lands on, and again when
 * they pick "Session recording" in the footer or their account menu. Both
 * answers are buttons of the same weight: saying no must be as easy as saying
 * yes, and closing the bar without answering records nothing. Nothing is shown
 * where no Sentry DSN is configured, since there is then nothing to record.
 */
export function ReplayConsent({ privacyUrl }: { privacyUrl: string | null }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ReplayChoice | null>(null);

  useEffect(() => {
    const dsn = window.__ENV__?.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (!dsn) return;
    const stored = readReplayChoice();
    setCurrent(stored);
    if (stored === null) setOpen(true);
    const reopen = () => {
      setCurrent(readReplayChoice());
      setOpen(true);
    };
    window.addEventListener(REPLAY_CONSENT_EVENT, reopen);
    return () => window.removeEventListener(REPLAY_CONSENT_EVENT, reopen);
  }, []);

  if (!open) return null;

  const choose = (choice: ReplayChoice) => {
    void saveReplayChoice(choice);
    setCurrent(choice);
    setOpen(false);
  };

  return (
    <div
      role="region"
      aria-label="Session recording"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-relaxed text-muted-foreground">
          May we record this visit to find and fix errors? The recording shows the
          pages as you see them, including what you type, and goes to Sentry in the
          EU. Nothing is recorded unless you allow it, and you can change your mind
          under &ldquo;Session recording&rdquo; at any time.
          {current ? (
            <> Currently {current === "granted" ? "allowed" : "not allowed"}.</>
          ) : null}
          {privacyUrl ? (
            <>
              {" "}
              <a href={privacyUrl} className="underline underline-offset-2">
                Privacy notice
              </a>
            </>
          ) : null}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => choose("denied")}>
            Don&rsquo;t record
          </Button>
          <Button variant="outline" size="sm" onClick={() => choose("granted")}>
            Allow recording
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "Session recording" for places that are not a menu, such as the footer. */
export function ReplayChoiceLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event(REPLAY_CONSENT_EVENT))}
    >
      Session recording
    </button>
  );
}
