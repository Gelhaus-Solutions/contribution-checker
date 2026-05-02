import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { env } from "@/lib/env";

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = new URL(`${ISSUER}/.well-known/jwks`);

export type GhActionsClaims = JWTPayload & {
  repository: string;
  repository_id: string;
  repository_owner: string;
  sub: string;
  workflow: string;
  event_name: string;
  actor: string;
};

let jwksOverride: JWTVerifyGetKey | null = null;
let cachedJwks: JWTVerifyGetKey | null = null;

function getJwks(): JWTVerifyGetKey {
  if (jwksOverride) return jwksOverride;
  if (!cachedJwks) cachedJwks = createRemoteJWKSet(JWKS_URL);
  return cachedJwks;
}

/** Test hook — pass a `createLocalJWKSet` resolver to verify against a local key. */
export function __setJwksForTesting(resolver: JWTVerifyGetKey | null): void {
  jwksOverride = resolver;
}

export function expectedAudienceForProject(slug: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/p/${slug}`;
}

export class OidcVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OidcVerificationError";
  }
}

export async function verifyGhActionsToken(args: {
  token: string;
  expectedAudience: string;
}): Promise<GhActionsClaims> {
  const { token, expectedAudience } = args;
  let result;
  try {
    result = await jwtVerify(token, getJwks(), {
      issuer: ISSUER,
      audience: expectedAudience,
      clockTolerance: 30,
    });
  } catch (e) {
    throw new OidcVerificationError(
      e instanceof Error ? e.message : "verification failed"
    );
  }
  const payload = result.payload as GhActionsClaims;
  if (typeof payload.repository !== "string" || !payload.repository.includes("/")) {
    throw new OidcVerificationError("missing or malformed repository claim");
  }
  if (typeof payload.sub !== "string" || !payload.sub.startsWith("repo:")) {
    throw new OidcVerificationError("missing or malformed sub claim");
  }
  return payload;
}
