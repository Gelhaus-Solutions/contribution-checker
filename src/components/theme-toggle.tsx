"use client";

import * as React from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THEME_COOKIE, isTheme, type Theme } from "@/app/theme-script";
import { cn } from "@/lib/cn";

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

function readCookie(): Theme {
  const m = document.cookie.match(
    new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`),
  );
  const v = m ? decodeURIComponent(m[1]) : undefined;
  return isTheme(v) ? v : "system";
}

function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Theme switcher. Writes the cc-theme cookie and flips the class immediately,
 * so switching costs no server round trip and no re-render. The cookie is what
 * the root layout reads on the next navigation to stamp the class server-side,
 * which is what keeps a pinned theme flash-free on a hard reload.
 */
export function ThemeToggle() {
  // The server has no way to render the correct initial icon (that is the whole
  // reason the resolver script exists), so start neutral and sync on mount.
  const [theme, setTheme] = React.useState<Theme>("system");

  React.useEffect(() => {
    setTheme(readCookie());
  }, []);

  // Follow the OS while the user is on "system". Without this, changing the OS
  // appearance does nothing until a reload.
  React.useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () =>
      document.documentElement.classList.toggle("dark", mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  function apply(next: Theme) {
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    const dark = next === "dark" || (next === "system" && prefersDark());
    document.documentElement.classList.toggle("dark", dark);
    setTheme(next);
  }

  const Active = (OPTIONS.find((o) => o.value === theme) ?? OPTIONS[2]).Icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Change theme"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Active className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-40">
        {OPTIONS.map(({ value, label, Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => apply(value)}>
            <Icon className="size-3.5" aria-hidden="true" />
            {label}
            <Check
              aria-hidden="true"
              className={cn(
                "ml-auto size-3.5",
                theme === value ? "opacity-100" : "opacity-0",
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
