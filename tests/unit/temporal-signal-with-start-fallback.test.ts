import { describe, it, expect, vi, beforeEach } from "vitest";
import { signalPrReGate } from "@/lib/temporal/start";

/**
 * The tolerant signalWithStart in src/lib/temporal/start.ts: when the server
 * rejects a start because of the carried Search Attributes (unregistered or
 * type-mismatched on the namespace), the start must be retried WITHOUT the
 * attributes instead of failing the gate; any other error must propagate so
 * the caller's retry policy still applies. Reproduces the production failure
 * shape exactly: the client wraps the gRPC INVALID_ARGUMENT in a
 * ServiceError("Failed to signalWithStart Workflow") with the cause chained.
 */

type Call = { workflowType: string; options: Record<string, unknown> };

const state = vi.hoisted(() => ({
  calls: [] as Call[],
  /** Error thrown for calls that carry typedSearchAttributes (null = none). */
  attributeError: null as Error | null,
  /** Error thrown for every call (takes precedence). */
  hardError: null as Error | null,
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/temporal/client", () => ({
  getTemporalClient: async () => ({
    workflow: {
      async signalWithStart(
        workflowType: string,
        options: Record<string, unknown>
      ) {
        state.calls.push({ workflowType, options });
        if (state.hardError) throw state.hardError;
        const attrs = options.typedSearchAttributes as unknown[] | undefined;
        if (state.attributeError && attrs && attrs.length > 0) {
          throw state.attributeError;
        }
      },
    },
  }),
}));

function wrappedRejection(details: string): Error {
  const grpc = new Error(details) as Error & { code: number; details: string };
  grpc.code = 3;
  grpc.details = details;
  return new Error("Failed to signalWithStart Workflow", { cause: grpc });
}

beforeEach(() => {
  state.calls = [];
  state.attributeError = null;
  state.hardError = null;
});

describe("signalWithStart search-attribute fallback", () => {
  it("passes typed attributes through on the happy path", async () => {
    await signalPrReGate("123", 5, { reason: "test", nonce: "n1" });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].workflowType).toBe("prGate");
    expect(state.calls[0].options.workflowId).toBe("pr:123:5");
    expect(state.calls[0].options.typedSearchAttributes).toHaveLength(1);
  });

  it("retries without attributes when the server rejects them", async () => {
    state.attributeError = wrappedRejection(
      "search attribute RepoId is not defined"
    );
    await signalPrReGate("123", 5, { reason: "test", nonce: "n1" });
    expect(state.calls).toHaveLength(2);
    const retry = state.calls[1].options;
    expect(retry.typedSearchAttributes).toBeUndefined();
    // Everything else is preserved: same id, queue, signal payload.
    expect(retry.workflowId).toBe("pr:123:5");
    expect(retry.signal).toBe(state.calls[0].options.signal);
    expect(retry.signalArgs).toEqual(state.calls[0].options.signalArgs);
  });

  it("propagates non-attribute INVALID_ARGUMENT errors", async () => {
    state.attributeError = wrappedRejection("missing task queue");
    await expect(
      signalPrReGate("123", 5, { reason: "test", nonce: "n1" })
    ).rejects.toThrow("Failed to signalWithStart Workflow");
    expect(state.calls).toHaveLength(1);
  });

  it("propagates transient errors untouched (the activity retry owns them)", async () => {
    const unavailable = new Error("Failed to signalWithStart Workflow", {
      cause: Object.assign(new Error("upstream connect error"), {
        code: 14,
        details: "upstream connect error",
      }),
    });
    state.hardError = unavailable;
    await expect(
      signalPrReGate("123", 5, { reason: "test", nonce: "n1" })
    ).rejects.toBe(unavailable);
    expect(state.calls).toHaveLength(1);
  });
});
