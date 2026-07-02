import { describe, it, expect } from "vitest";
import {
  ensureSearchAttributes,
  isSearchAttributeRejection,
  INDEXED_VALUE_TYPE,
  type OperatorServiceLike,
} from "@/lib/temporal/search-attribute-registration";
import { SEARCH_ATTRIBUTE_REGISTRATIONS } from "@/lib/temporal/search-attributes";

/** A gRPC-shaped error (code + details), like @grpc/grpc-js ServiceError. */
function grpcError(code: number, details: string): Error {
  const e = new Error(`${code} ${details}`) as Error & {
    code: number;
    details: string;
  };
  e.code = code;
  e.details = details;
  return e;
}

/** The client-wrapped shape the SDK actually throws from signalWithStart:
 * ServiceError("Failed to signalWithStart Workflow") with the gRPC error as
 * its cause (see @temporalio/client rethrowGrpcError). */
function wrappedRejection(details: string): Error {
  return new Error("Failed to signalWithStart Workflow", {
    cause: grpcError(3, details),
  });
}

type AddCall = { namespace: string; searchAttributes: Record<string, number> };

function fakeOperator(opts: {
  /** null = listSearchAttributes throws UNIMPLEMENTED (time-skipping server). */
  existing: Record<string, number> | null;
  addError?: (name: string) => Error | null;
}): { operator: OperatorServiceLike; adds: AddCall[] } {
  const adds: AddCall[] = [];
  const operator: OperatorServiceLike = {
    async listSearchAttributes() {
      if (opts.existing === null) {
        throw grpcError(12, "unimplemented");
      }
      return { customAttributes: { ...opts.existing } };
    },
    async addSearchAttributes(request) {
      const name = Object.keys(request.searchAttributes)[0];
      const err = opts.addError?.(name);
      if (err) throw err;
      adds.push(request as AddCall);
    },
  };
  return { operator, adds };
}

const ALL_NAMES = SEARCH_ATTRIBUTE_REGISTRATIONS.map((r) => r.name);

describe("ensureSearchAttributes", () => {
  it("adds every attribute to an empty namespace", async () => {
    const { operator, adds } = fakeOperator({ existing: {} });
    const res = await ensureSearchAttributes(operator, "default");
    expect(res.added).toEqual(ALL_NAMES);
    expect(res.present).toEqual([]);
    expect(res.mismatched).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(res.blind).toBe(false);
    // One call per attribute, with the type from the registration table.
    expect(adds.map((a) => a.searchAttributes)).toEqual(
      SEARCH_ATTRIBUTE_REGISTRATIONS.map((r) => ({
        [r.name]: INDEXED_VALUE_TYPE[r.type],
      }))
    );
  });

  it("skips registered attributes and adds only the missing ones", async () => {
    const [first, ...rest] = SEARCH_ATTRIBUTE_REGISTRATIONS;
    const { operator, adds } = fakeOperator({
      existing: { [first.name]: INDEXED_VALUE_TYPE[first.type] },
    });
    const res = await ensureSearchAttributes(operator, "default");
    expect(res.present).toEqual([first.name]);
    expect(res.added).toEqual(rest.map((r) => r.name));
    expect(adds).toHaveLength(rest.length);
  });

  it("reports a type mismatch without blocking the other attributes", async () => {
    // The regression that mattered in prod: the old all-or-nothing script
    // aborted on the first mismatch, leaving every OTHER attribute
    // unregistered, which rejected all entity starts.
    const [first, ...rest] = SEARCH_ATTRIBUTE_REGISTRATIONS;
    const wrongType = INDEXED_VALUE_TYPE[first.type] === 2 ? 3 : 2;
    const { operator } = fakeOperator({
      existing: { [first.name]: wrongType },
    });
    const res = await ensureSearchAttributes(operator, "default");
    expect(res.mismatched).toEqual([
      {
        name: first.name,
        registered: wrongType,
        wanted: INDEXED_VALUE_TYPE[first.type],
      },
    ]);
    expect(res.added).toEqual(rest.map((r) => r.name));
    expect(res.failed).toEqual([]);
  });

  it("treats an already-exists race as success and isolates other failures", async () => {
    const [first, second, ...rest] = SEARCH_ATTRIBUTE_REGISTRATIONS;
    const { operator } = fakeOperator({
      existing: {},
      addError: (name) => {
        // A concurrent replica won the race for the first attribute.
        if (name === first.name) {
          return grpcError(6, `Search attribute ${name} already exists.`);
        }
        // The second hits a per-type visibility cap; the rest must still land.
        if (name === second.name) {
          return grpcError(3, "too many search attributes of type Int");
        }
        return null;
      },
    });
    const res = await ensureSearchAttributes(operator, "default");
    expect(res.present).toEqual([first.name]);
    expect(res.failed.map((f) => f.name)).toEqual([second.name]);
    expect(res.added).toEqual(rest.map((r) => r.name));
  });

  it("falls back to blind adds when list is unimplemented (test server)", async () => {
    const { operator, adds } = fakeOperator({ existing: null });
    const res = await ensureSearchAttributes(operator, "default");
    expect(res.blind).toBe(true);
    expect(res.added).toEqual(ALL_NAMES);
    expect(adds).toHaveLength(ALL_NAMES.length);
  });

  it("rethrows a non-unimplemented list failure (e.g. Temporal Cloud)", async () => {
    const operator: OperatorServiceLike = {
      async listSearchAttributes() {
        throw grpcError(7, "Operator API is not available");
      },
      async addSearchAttributes() {},
    };
    await expect(ensureSearchAttributes(operator, "default")).rejects.toThrow(
      /not available/
    );
  });
});

describe("isSearchAttributeRejection", () => {
  it("matches the wrapped unregistered-attribute rejection", () => {
    expect(
      isSearchAttributeRejection(
        wrappedRejection("search attribute ProjectId is not defined")
      )
    ).toBe(true);
  });

  it("matches a type-mismatch rejection", () => {
    expect(
      isSearchAttributeRejection(
        wrappedRejection(
          "invalid value for search attribute RepoId of type Keyword: 42"
        )
      )
    ).toBe(true);
  });

  it("ignores INVALID_ARGUMENT for other reasons", () => {
    expect(
      isSearchAttributeRejection(wrappedRejection("missing task queue"))
    ).toBe(false);
  });

  it("ignores other gRPC codes and plain errors", () => {
    expect(
      isSearchAttributeRejection(
        new Error("Failed to signalWithStart Workflow", {
          cause: grpcError(14, "search attribute backend unavailable"),
        })
      )
    ).toBe(false);
    expect(isSearchAttributeRejection(new Error("boom"))).toBe(false);
    expect(isSearchAttributeRejection(undefined)).toBe(false);
  });
});
