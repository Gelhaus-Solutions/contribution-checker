import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type KeyLike,
} from "jose";
import {
  __setJwksForTesting,
  expectedAudienceForProject,
  OidcVerificationError,
  verifyGhActionsToken,
} from "@/lib/ci/oidc";

const ISSUER = "https://token.actions.githubusercontent.com";

let privateKey: KeyLike | Uint8Array;
let signKid: string;

async function mintToken(args: {
  audience?: string;
  issuer?: string;
  repository?: string | null;
  sub?: string | null;
  expiresIn?: string;
  notBefore?: number;
}): Promise<string> {
  const { audience, issuer, repository, sub, expiresIn, notBefore } = args;
  const claims: Record<string, unknown> = {
    repository: repository === null ? undefined : repository ?? "octo/repo",
    repository_id: "12345",
    repository_owner: "octo",
    workflow: "Contribution check (gate)",
    event_name: "pull_request_target",
    actor: "octocat",
  };
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: signKid })
    .setIssuedAt()
    .setIssuer(issuer ?? ISSUER)
    .setAudience(audience ?? expectedAudienceForProject("acme"))
    .setExpirationTime(expiresIn ?? "5m");
  if (notBefore !== undefined) jwt = jwt.setNotBefore(notBefore);
  const finalSub = sub === null ? undefined : sub ?? "repo:octo/repo:ref:refs/heads/main";
  if (finalSub !== undefined) {
    (claims as Record<string, unknown>).sub = finalSub;
    jwt = new SignJWT({ ...claims, sub: finalSub })
      .setProtectedHeader({ alg: "RS256", kid: signKid })
      .setIssuedAt()
      .setIssuer(issuer ?? ISSUER)
      .setAudience(audience ?? expectedAudienceForProject("acme"))
      .setExpirationTime(expiresIn ?? "5m")
      .setSubject(finalSub);
    if (notBefore !== undefined) jwt = jwt.setNotBefore(notBefore);
  }
  return jwt.sign(privateKey);
}

beforeAll(async () => {
  process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
  const { privateKey: priv, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  privateKey = priv;
  const publicJwk = await exportJWK(publicKey);
  signKid = "test-key-1";
  publicJwk.kid = signKid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const localResolver = createLocalJWKSet({ keys: [publicJwk] });
  __setJwksForTesting(localResolver);
});

afterAll(() => {
  __setJwksForTesting(null);
});

describe("verifyGhActionsToken", () => {
  it("accepts a token signed with matching audience and issuer", async () => {
    const token = await mintToken({});
    const claims = await verifyGhActionsToken({
      token,
      expectedAudience: expectedAudienceForProject("acme"),
    });
    expect(claims.repository).toBe("octo/repo");
    expect(claims.sub).toMatch(/^repo:octo\/repo:/);
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await mintToken({ audience: "https://attacker/p/foo" });
    await expect(
      verifyGhActionsToken({
        token,
        expectedAudience: expectedAudienceForProject("acme"),
      })
    ).rejects.toBeInstanceOf(OidcVerificationError);
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = await mintToken({ issuer: "https://accounts.google.com" });
    await expect(
      verifyGhActionsToken({
        token,
        expectedAudience: expectedAudienceForProject("acme"),
      })
    ).rejects.toBeInstanceOf(OidcVerificationError);
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 600;
    const token = await new SignJWT({
      repository: "octo/repo",
      repository_id: "12345",
      repository_owner: "octo",
      workflow: "wf",
      event_name: "pull_request_target",
      actor: "octocat",
    })
      .setProtectedHeader({ alg: "RS256", kid: signKid })
      .setIssuer(ISSUER)
      .setAudience(expectedAudienceForProject("acme"))
      .setSubject("repo:octo/repo:ref:refs/heads/main")
      .setIssuedAt(past - 60)
      .setExpirationTime(past)
      .sign(privateKey);
    await expect(
      verifyGhActionsToken({
        token,
        expectedAudience: expectedAudienceForProject("acme"),
      })
    ).rejects.toBeInstanceOf(OidcVerificationError);
  });

  it("rejects a token without a repository claim", async () => {
    const token = await mintToken({ repository: null });
    await expect(
      verifyGhActionsToken({
        token,
        expectedAudience: expectedAudienceForProject("acme"),
      })
    ).rejects.toBeInstanceOf(OidcVerificationError);
  });

  it("rejects a token without a sub claim", async () => {
    const token = await mintToken({ sub: null });
    await expect(
      verifyGhActionsToken({
        token,
        expectedAudience: expectedAudienceForProject("acme"),
      })
    ).rejects.toBeInstanceOf(OidcVerificationError);
  });
});

describe("expectedAudienceForProject", () => {
  it("formats the audience using PUBLIC_BASE_URL and slug", () => {
    expect(expectedAudienceForProject("acme")).toMatch(/\/p\/acme$/);
  });
});
