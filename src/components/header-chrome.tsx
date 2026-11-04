"use client";

import {
  CACHE_KEY,
  createChromeCore,
  type AccountItem,
  type AccountPerson,
  type ChromeCore,
} from "@ghub/identity-chrome";
import { GpAccount, GpApps } from "@ghub/identity-chrome/react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { useBrand } from "@/components/brand";
import { reopenReplayChoice } from "@/lib/observability/replay-consent";

/**
 * GPlatform Identity's shared controls at the right of the header (GPLATSSO-33,
 * D16 and D18): the apps picker, then the account popup on the person's
 * picture.
 *
 * Drawn only where the server has the controls set up (`identityChrome` in
 * `lib/identity-chrome.ts`); elsewhere `UserCluster` draws a plain Admin link
 * and sign-out button, because a core that is off draws nothing at all. The
 * popup carries the data export, session recording and, for super-admins,
 * Admin. There are no account settings here: GPID keeps the account.
 * Contribution Checker has no organisations of its
 * own to switch between, so the popup lists none.
 *
 * **Nothing is kept on the device** (operator D383, GPLATLEGAL-227): the core
 * gets no storage and asks its route on each page. The entry an earlier
 * version kept in local storage (picture address, colour, products used, 30
 * days) is removed once.
 */

const svg = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

/** lucide's Download, Video and Shield, as the old menu drew them. */
const ICONS = {
  download: svg(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  ),
  video: svg(
    '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  ),
  shield: svg(
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  ),
};

/** The entry the header once kept in local storage, gone the first time this runs. */
function forgetOldCache(): void {
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    // Storage refused (a private window, blocked site data): there is nothing to remove.
  }
}

let shared: ChromeCore | null = null;

/**
 * One core for the page, so the two controls share one fetch, as the package
 * intends, and nothing is stored. It lives as long as the page. None on the
 * server, which draws only the bare tags.
 */
function pageCore(): ChromeCore | null {
  if (typeof window === "undefined") return null;
  if (shared === null) {
    forgetOldCache();
    shared = createChromeCore({
      enabled: true,
      endpoint: "/api/identity-chrome",
    });
  }
  return shared;
}

export interface HeaderChromePerson {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

export function HeaderChrome({
  person: user,
  isSuperAdmin,
}: {
  person: HeaderChromePerson;
  isSuperAdmin: boolean;
}) {
  const router = useRouter();
  const { name: product } = useBrand();
  const core = useMemo(() => pageCore(), []);

  const person = useMemo<AccountPerson>(
    () => ({
      name: user.name || user.email,
      email: user.email,
      id: user.id,
      // The GitHub picture this app holds; Identity's own picture wins over it.
      avatarUrl: user.image,
    }),
    [user.name, user.email, user.id, user.image],
  );

  const items = useMemo<AccountItem[]>(() => {
    const routed = (
      id: string,
      href: string,
      label: string,
      icon: string,
    ): AccountItem => ({
      id,
      label,
      href,
      icon,
      onSelect: (event: MouseEvent) => {
        event.preventDefault();
        router.push(href);
      },
    });
    return [
      // Self-service data export (GDPR Art. 15 and 20). A plain link: the
      // route answers with Content-Disposition: attachment, so the browser
      // downloads the file and stays on the page.
      {
        id: "export",
        label: "Download my data",
        href: "/api/account/export",
        icon: ICONS.download,
      },
      // Where a yes or no to session recording is changed (see ReplayConsent).
      {
        id: "recording",
        label: "Session recording",
        onSelect: () => reopenReplayChoice(),
        icon: ICONS.video,
      },
      ...(isSuperAdmin
        ? [routed("admin", "/admin", "Admin", ICONS.shield)]
        : []),
    ];
  }, [isSuperAdmin, router]);

  // The sign-out route ends this app's session (POST only), then home.
  const onSignOut = useCallback((): void => {
    void fetch("/auth/sign-out", { method: "POST", redirect: "manual" })
      .catch(() => undefined)
      .finally(() => window.location.assign("/"));
  }, []);

  return (
    <div className="flex items-center gap-1">
      <GpApps core={core} />
      <GpAccount
        core={core}
        person={person}
        organisations={[]}
        product={product}
        items={items}
        onSwitch={() => Promise.reject(new Error("no organisations"))}
        onSignOut={onSignOut}
      />
    </div>
  );
}
