import { describe, expect, it } from "vitest";
import {
  readReplayChoice,
  REPLAY_CONSENT_KEY,
  saveReplayChoice,
} from "@/lib/observability/replay-consent";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

describe("replay consent", () => {
  it("has no choice until one is made, so nothing is recorded", () => {
    expect(readReplayChoice(memoryStorage())).toBeNull();
  });

  it("reads only the two answers it writes", () => {
    expect(readReplayChoice(memoryStorage({ [REPLAY_CONSENT_KEY]: "granted" }))).toBe("granted");
    expect(readReplayChoice(memoryStorage({ [REPLAY_CONSENT_KEY]: "denied" }))).toBe("denied");
    expect(readReplayChoice(memoryStorage({ [REPLAY_CONSENT_KEY]: "yes" }))).toBeNull();
  });

  it("stores a yes and a no, and a later answer replaces the earlier one", async () => {
    const storage = memoryStorage();
    await saveReplayChoice("granted", storage);
    expect(readReplayChoice(storage)).toBe("granted");
    await saveReplayChoice("denied", storage);
    expect(readReplayChoice(storage)).toBe("denied");
  });

  it("treats storage that throws as no choice", () => {
    const broken = memoryStorage();
    broken.getItem = () => {
      throw new Error("blocked");
    };
    expect(readReplayChoice(broken)).toBeNull();
  });

  it("keeps working when storage cannot be written", async () => {
    const full = memoryStorage();
    full.setItem = () => {
      throw new Error("quota");
    };
    await expect(saveReplayChoice("denied", full)).resolves.toBeUndefined();
  });
});
