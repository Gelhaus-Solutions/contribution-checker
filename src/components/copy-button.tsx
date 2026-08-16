"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * Copy-to-clipboard button.
 *
 * navigator.clipboard is only exposed in a secure context, and this app is
 * explicitly deployable over plain HTTP (next.config.ts gates HSTS on
 * PUBLIC_BASE_URL starting with https), so it has to fall back rather than
 * silently do nothing. The fallback is the old textarea + execCommand route,
 * which is deprecated but is the only thing that works on an insecure origin.
 */
function copyText(value: string): boolean {
  if (navigator.clipboard?.writeText) {
    // Fire and forget: the promise can still reject on a permissions policy,
    // so the fallback below runs as a catch.
    navigator.clipboard.writeText(value).catch(() => legacyCopy(value));
    return true;
  }
  return legacyCopy(value);
}

function legacyCopy(value: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    // Keep it out of view and out of the layout, and avoid scrolling the page
    // to the bottom on focus.
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = "Copy",
  variant = "ghost",
  size = "sm",
  iconOnly = false,
  className,
}: {
  value: string;
  label?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  iconOnly?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  React.useEffect(() => () => clearTimeout(timer.current), []);

  function onClick() {
    if (!copyText(value)) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  const Icon = copied ? Check : Copy;

  return (
    <Button
      type="button"
      variant={variant}
      size={iconOnly ? "icon" : size}
      onClick={onClick}
      aria-label={iconOnly ? label : undefined}
      className={cn(iconOnly && "size-7", className)}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {iconOnly ? null : copied ? "Copied" : label}
      {/* Announced without moving anything on screen. */}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </Button>
  );
}
