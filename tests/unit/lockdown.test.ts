import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "cc-lockdown-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function stageFile(
  rung: string,
  stage = rung === "aal" || rung === "aal2" ? "full" : rung,
) {
  const tmp = join(dir, "contribution-checker.json.tmp");
  writeFileSync(
    tmp,
    JSON.stringify({
      v: 1,
      app: "contribution-checker",
      rung,
      stage,
      at: 1_791_700_000,
    }),
  );
  renameSync(tmp, join(dir, "contribution-checker.json"));
}

async function load(floor?: string) {
  vi.resetModules();
  vi.stubEnv("GLOCKDOWN_STAGE_DIR", dir);
  vi.stubEnv("CC_LOCKDOWN", floor ?? "off");
  vi.stubEnv("GLOCKDOWN_EDGE_URL", "");
  return import("@/lib/lockdown");
}

describe("GLockdown's kill switch", () => {
  beforeEach(() => {
    rmSync(join(dir, "contribution-checker.json"), { force: true });
    vi.unstubAllEnvs();
  });

  it("is off while the agent has written nothing, and follows the file", async () => {
    const l = await load();
    expect(l.lockdown()).toEqual({ stage: "off", rung: null });
    stageFile("members");
    l.resetLockdownForTests();
    expect(l.lockdown()).toEqual({ stage: "members", rung: "members" });
  });

  it("takes the stricter of the file and CC_LOCKDOWN, which nothing lowers", async () => {
    stageFile("signups");
    const l = await load("admins");
    expect(l.lockdown().stage).toBe("admins");
  });

  it("refuses everyone at AAL phase 1, and stops the bot only from phase 2", async () => {
    stageFile("aal");
    const l = await load();
    expect(l.lockdown()).toEqual({ stage: "full", rung: "aal" });
    expect(l.botStopped()).toBe(false);
    stageFile("aal2");
    l.resetLockdownForTests();
    expect(l.botStopped()).toBe(true);
  });

  it("does not stop the bot for the env floor alone", async () => {
    const l = await load("full");
    expect(l.lockdown().stage).toBe("full");
    expect(l.botStopped()).toBe(false);
  });
});
