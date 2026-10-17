import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The route the shared header controls ask reports only a verified address to
 * GPlatform Identity, never a restricted account's, and is absent on an
 * instance that has not set it up.
 */

type User = {
  email?: string | null;
  emailVerified?: boolean;
  restricted?: boolean;
};

const session = vi.hoisted(() => ({ user: null as null | User }));
const asked = vi.hoisted(() => ({ who: [] as unknown[], configured: true }));

vi.mock("@/auth", () => ({
  auth: async () => (session.user === null ? null : { user: session.user }),
}));
vi.mock("@/lib/identity-chrome", () => ({
  get identityChrome() {
    if (!asked.configured) return null;
    return {
      handler:
        (who: (request: Request) => Promise<unknown>) =>
        async (request: Request) => {
          const person = await who(request);
          asked.who.push(person);
          return new Response(null, { status: person === null ? 401 : 200 });
        },
    };
  },
}));

async function get(): Promise<Response> {
  vi.resetModules();
  const { GET } = await import("@/app/api/identity-chrome/route");
  return GET(
    new Request("https://contribute.example.test/api/identity-chrome"),
  );
}

beforeEach(() => {
  asked.who = [];
  asked.configured = true;
});

describe("GET /api/identity-chrome", () => {
  it("tells Identity a verified address", async () => {
    session.user = { email: "mira@hafenlabs.example", emailVerified: true };
    expect((await get()).status).toBe(200);
    expect(asked.who).toEqual([{ email: "mira@hafenlabs.example" }]);
  });

  it("answers an unverified address as nobody, so Identity is never asked about it", async () => {
    session.user = { email: "mira@hafenlabs.example", emailVerified: false };
    expect((await get()).status).toBe(401);
    expect(asked.who).toEqual([null]);
  });

  it("answers an account an administrator restricted as nobody", async () => {
    session.user = {
      email: "mira@hafenlabs.example",
      emailVerified: true,
      restricted: true,
    };
    expect((await get()).status).toBe(401);
    expect(asked.who).toEqual([null]);
  });

  it("is not there on an instance that has not set it up", async () => {
    asked.configured = false;
    session.user = { email: "mira@hafenlabs.example", emailVerified: true };
    expect((await get()).status).toBe(404);
    expect(asked.who).toEqual([]);
  });
});
