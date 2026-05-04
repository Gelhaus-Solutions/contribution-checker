"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tracks per-key loading + transient success for click-driven async actions.
 * Drives the Button component's `loading` and `success` props so users get a
 * spinner while the action runs and a brief checkmark when it completes.
 *
 * Usage:
 *   const fb = useActionFeedback<"rescan" | "reeval">();
 *   <Button loading={fb.isLoading("rescan")} success={fb.isSuccess("rescan")}
 *           onClick={() => fb.run("rescan", () => doRescan())} />
 */
export function useActionFeedback<K extends string = string>(
  successDuration = 1500
) {
  const [loadingKey, setLoadingKey] = useState<K | null>(null);
  const [successKey, setSuccessKey] = useState<K | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const run = useCallback(
    async <T,>(key: K, fn: () => Promise<T>): Promise<T> => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setLoadingKey(key);
      setSuccessKey(null);
      try {
        const result = await fn();
        setSuccessKey(key);
        timer.current = setTimeout(() => {
          setSuccessKey((cur) => (cur === key ? null : cur));
          timer.current = null;
        }, successDuration);
        return result;
      } finally {
        setLoadingKey((cur) => (cur === key ? null : cur));
      }
    },
    [successDuration]
  );

  return {
    run,
    isLoading: (key: K) => loadingKey === key,
    isSuccess: (key: K) => successKey === key,
    isAnyLoading: loadingKey !== null,
    loadingKey,
    successKey,
  };
}
