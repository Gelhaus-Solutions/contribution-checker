import { AsyncLocalStorage } from "node:async_hooks";
import {
  GmintClient,
  GmintError,
  type GmintClientOptions,
  type GmintToken,
  type TokenRequest,
} from "@ghub/gmint-sdk";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Installation tokens from GMint (E11-03), for the GitHub Apps listed in
 * `GMINT_GITHUB_APP_IDS`: this app never reads those Apps' private keys. The
 * same shape as GAdvisory's `gmint-tokens.ts` (E11-02).
 *
 * GMint mints a token only for a grant in its signed policy, one per purpose
 * and installation, named `<purpose>-<installation id>`, and a request must
 * stay inside that grant's ceiling. Each caller therefore names its need (see
 * `getInstallationOctokit`), and the token carries exactly that need plus the
 * `metadata: read` GitHub grants with every token.
 *
 * A token is kept for the same need, installation and tenant while it has more
 * than five minutes left, because one webhook makes several GitHub calls and
 * GMint's grant rates count mints, not calls. Concurrent asks for the same need
 * share one mint.
 */

/**
 * What a token is for. Each is one grant per installation in GMint's policy;
 * the ceilings are listed with the calls in `pr-actions.ts` and the modules
 * that name them.
 */
export type GmintPurpose =
  | "pr-actions"
  | "check-run"
  | "staging"
  | "quality"
  | "cla"
  | "repo-link";

/**
 * Who the work is for (D-42): the project, or the instance as a whole (no call
 * acts for the instance today: every GitHub call is for one project's repo).
 * GMint's policy lists the tenants each grant may act for.
 */
export type GithubTenant = "instance" | `project:${string}`;

export function projectTenant(projectId: string): GithubTenant {
  return `project:${projectId}`;
}

export type GithubPermissions = TokenRequest["permissions"];

/** What one call needs from GitHub. */
export interface TokenNeed {
  purpose: GmintPurpose;
  /**
   * The repositories, by name within the installation (no owner). Absent asks
   * for an org-scoped token, which GMint gives only for an org-scoped grant and
   * which carries organization permissions only.
   */
  repositories?: string[];
  /** Without `metadata`, which is always added. */
  permissions: GithubPermissions;
}

/** A cached token is handed out again only while this much of it is left. */
export const REUSE_MARGIN_MS = 5 * 60_000;

/** Past this many cached tokens, expired ones are dropped on the next mint. */
const PRUNE_AT = 256;

export type GmintSettings = {
  /** Numeric ids of the GitHub Apps whose keys GMint holds. */
  appIds: string[];
  client?: Omit<GmintClientOptions, "onRenewError">;
};

/**
 * A token GMint would not give. `status` says what an HTTP caller would answer
 * (403 refused, 503 unavailable or locked down, 500 an answer that failed
 * verification); `retryable` is GMint's own word on whether asking again later
 * can help, and `classifyGithubError` honours it at activity boundaries.
 */
export class GmintRefusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "GmintRefusal";
  }
}

/**
 * GMint not answering, as opposed to refusing: asking again later can help. A
 * lockdown is deliberate and is not an outage.
 */
export function isGmintOutage(e: unknown): e is GmintRefusal {
  return (
    e instanceof GmintRefusal &&
    e.retryable &&
    e.status === 503 &&
    e.code !== "locked_down"
  );
}

const outageWatch = new AsyncLocalStorage<{ outage: GmintRefusal | null }>();

/**
 * Runs `work` and says whether GMint stopped answering during it.
 *
 * Every GitHub side effect catches its own failure and logs it, so a piece of
 * work that ran while GMint was down completes as if nothing happened: no
 * check, no label, no comment, and nobody asks again. That is how PRs gated
 * during the vps1 outage of 2026-11-09 were left without checks. The refusal is
 * noted here where each caller receives it, before anybody can swallow it, so
 * the activity can refuse to report the work done.
 */
export async function watchGmint<T>(
  work: () => Promise<T>,
): Promise<{ value: T; outage: GmintRefusal | null }> {
  const seen: { outage: GmintRefusal | null } = { outage: null };
  const value = await outageWatch.run(seen, work);
  return { value, outage: seen.outage };
}

/** Notes an outage for the `watchGmint` around the current work, if any. */
export function noteGmintOutage(e: unknown): void {
  if (!isGmintOutage(e)) return;
  const seen = outageWatch.getStore();
  if (seen && !seen.outage) seen.outage = e;
}

type Cached = { token: GmintToken; installationId: number };

export class GmintTokens {
  private readonly appIds: ReadonlySet<string>;
  /** Undefined until first needed: building it reads key files from disk. */
  private client: GmintClient | null | undefined;
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<GmintToken>>();

  constructor(
    private readonly settings: GmintSettings,
    private readonly now: () => number = Date.now,
  ) {
    this.appIds = new Set(
      settings.appIds.map((id) => id.trim()).filter(Boolean),
    );
    if (this.appIds.size > 0 && !settings.client) {
      // Listing an App without the identity to reach GMint must not fall back
      // to the App's own key: that is the key being retired.
      logger.error(
        "GMINT_GITHUB_APP_IDS is set but GMint's client settings are not: those Apps mint nothing",
      );
    }
  }

  /** Whether GMint holds the key of the GitHub App with this numeric id. */
  manages(appId: string): boolean {
    return this.appIds.has(appId.trim());
  }

  /**
   * A token for exactly `need` on one installation, for work done for
   * `tenant`. Throws `GmintRefusal` when GMint gives none.
   */
  async token(
    installationId: number,
    need: TokenNeed,
    tenant: GithubTenant,
  ): Promise<string> {
    const permissions: GithubPermissions = {
      metadata: "read",
      ...need.permissions,
    };
    const key = JSON.stringify([
      installationId,
      need.purpose,
      [...(need.repositories ?? [])].sort(),
      Object.entries(permissions).sort(),
      tenant,
    ]);
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.token.expiresAt.getTime() - REUSE_MARGIN_MS > this.now()
    ) {
      return cached.token.reveal();
    }

    let pending = this.inflight.get(key);
    if (!pending) {
      const client = this.clientOrThrow();
      pending = client
        .getToken({
          grant: `${need.purpose}-${installationId}`,
          installationId,
          ...(need.repositories ? { repositories: need.repositories } : {}),
          permissions,
          tenant,
          purpose: need.purpose,
        })
        .then(
          (token) => {
            this.store(key, { token, installationId });
            return token;
          },
          (e: unknown) => {
            throw this.refusal(e, installationId, need);
          },
        )
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    try {
      return (await pending).reveal();
    } catch (e) {
      // Here, not where the refusal is built: concurrent asks share one mint,
      // and each caller's work has to hear of the outage, not only the first.
      noteGmintOutage(e);
      throw e;
    }
  }

  /** Forgets every token of an installation, after GitHub refused one. */
  forget(installationId: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.installationId === installationId) this.cache.delete(key);
    }
  }

  /** Forgets every token, for `invalidateGitHubAppCache`. */
  forgetAll(): void {
    this.cache.clear();
  }

  /** Stops the client's certificate renewal timer. */
  close(): void {
    this.client?.close();
  }

  private store(key: string, entry: Cached): void {
    if (this.cache.size >= PRUNE_AT) {
      const now = this.now();
      for (const [k, v] of this.cache) {
        if (v.token.expiresAt.getTime() <= now) this.cache.delete(k);
      }
    }
    this.cache.set(key, entry);
  }

  private clientOrThrow(): GmintClient {
    if (this.client === undefined) {
      const c = this.settings.client;
      if (!c) {
        this.client = null;
      } else {
        try {
          this.client = new GmintClient({
            ...c,
            // A certificate that runs out cannot be renewed, only enrolled
            // again (GMint's RB-08): page someone.
            onRenewError: (e) =>
              logger.error({ err: e }, "GMint certificate renewal failed"),
          });
        } catch (e) {
          // Left unset, so the next call tries again once the files are fixed.
          logger.error({ err: e }, "GMint client could not be set up");
          throw new GmintRefusal(
            "unconfigured",
            503,
            false,
            "This GitHub App's tokens come from GMint, whose client settings could not be loaded",
          );
        }
      }
    }
    if (!this.client) {
      throw new GmintRefusal(
        "unconfigured",
        503,
        false,
        "This GitHub App's tokens come from GMint, which is not configured",
      );
    }
    return this.client;
  }

  private refusal(e: unknown, installationId: number, need: TokenNeed): Error {
    if (!(e instanceof GmintError)) return e as Error;
    const where = {
      installationId,
      purpose: need.purpose,
      repositories: need.repositories,
    };
    switch (e.code) {
      case "locked_down":
        // Its own state on purpose: GitHub access is locked down, nothing broke.
        return new GmintRefusal(
          e.code,
          503,
          e.retryable,
          "GitHub access is locked down",
        );
      case "denied":
      case "quarantined":
      case "approval_required":
      case "approval_unavailable":
        logger.error({ ...where, err: e }, "GMint refused a token");
        return new GmintRefusal(
          e.code,
          403,
          e.retryable,
          "GMint does not allow this for the installation",
        );
      case "untrusted":
        // An answer that failed verification is an attack, not an outage.
        logger.error(
          { ...where, err: e },
          "GMint's answer failed verification",
        );
        return new GmintRefusal(
          e.code,
          500,
          false,
          "GMint's answer failed verification",
        );
      default:
        return new GmintRefusal(
          e.code,
          503,
          e.retryable,
          e.retryable
            ? "GMint is not answering; try again later"
            : `GMint: ${e.code}`,
        );
    }
  }
}

let shared: GmintTokens | null = null;

/** The process-wide token source, from the environment. */
export function gmintTokens(): GmintTokens {
  if (!shared) shared = new GmintTokens(env.gmint);
  return shared;
}

/** Test seam. */
export function resetGmintTokensForTests(): void {
  shared?.close();
  shared = null;
}
