import "server-only";
import {
  createChromeServer,
  type ChromeServer,
} from "@ghub/identity-chrome/server";
import { env } from "@/lib/env";

/**
 * GPlatform Identity's server half for the shared header controls (the apps
 * picker and the account popup, GPLATSSO-33), or null on an instance that has
 * not set it up.
 *
 * **Off unless both settings are present.** `GPID_URL` is Identity's address
 * and `GPID_CHROME_TOKEN` the token staff issue for Contribution Checker on
 * Identity's product screen. A self-hosted instance sets neither: the header
 * keeps Hexclave's user button and nothing asks Identity anything.
 */
export const identityChrome: ChromeServer | null =
  env.GPID_URL && env.GPID_CHROME_TOKEN
    ? createChromeServer({
        baseUrl: env.GPID_URL,
        product: "contribution-checker",
        token: env.GPID_CHROME_TOKEN,
      })
    : null;
