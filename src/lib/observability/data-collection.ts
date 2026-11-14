import type * as Sentry from "@sentry/nextjs";

type DataCollection = NonNullable<NonNullable<Parameters<typeof Sentry.init>[0]>["dataCollection"]>;

/**
 * What Sentry may collect, for every runtime (server, edge, browser).
 *
 * No IP address, cookies or request bodies (GDPR Art. 5(1)(c)). SDK 11
 * replaced `sendDefaultPii: false` with these categories and collects all of
 * them when this is left out, so each one is turned off here. Headers and
 * query parameters that carry an address or a user are denied by name, which
 * is what `sendDefaultPii: false` used to leave out.
 */
const addressOrUser = ["forwarded", "-ip", "remote-", "via", "-user"];

export const dataCollection: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { deny: addressOrUser },
    response: { deny: addressOrUser },
  },
  httpBodies: [],
  urlQueryParams: { deny: addressOrUser },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  graphQL: { document: false, variables: false },
};
