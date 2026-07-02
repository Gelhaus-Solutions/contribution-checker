import {
  SEARCH_ATTRIBUTE_REGISTRATIONS,
} from "./search-attributes";

/**
 * Idempotent registration of the app's custom Search Attributes on a Temporal
 * namespace, shared by the worker startup path (src/worker/run.ts), the
 * standalone deploy script (scripts/register-search-attributes.ts), and the
 * unit-test helper (ephemeral test servers start with an empty namespace).
 *
 * Why the worker self-registers: an execution that carries an unregistered
 * attribute is rejected by the server with INVALID_ARGUMENT ("search attribute
 * X is not defined"). Every entity signalWithStart in start.ts carries typed
 * attributes, so on a namespace nobody registered (fresh cluster, or the
 * in-memory `temporal server start-dev` from docker-compose, which forgets
 * registrations on every restart) the whole gate is down: the scheduled
 * ensureProjectGates workflow fails permanently and webhook dispatches are
 * rejected. The container entrypoint applies DB migrations itself (`prisma
 * migrate deploy`) but had no equivalent for this namespace-level migration;
 * this module is that equivalent.
 *
 * Registration is per-attribute (not one bulk call) so a single conflicted or
 * capped name cannot block the rest, and races between worker replicas are
 * benign: the loser's add fails with "already exists", which is success.
 *
 * The Operator API is unavailable on Temporal Cloud (gRPC unauthorized); the
 * worker treats that as a soft failure and logs the remediation (register via
 * tcld or the Cloud UI). SQL-visibility namespaces cap custom attributes per
 * type; a capped add is reported in `failed`, never thrown.
 */

/** temporal.api.enums.v1.IndexedValueType values, keyed by the
 * SearchAttributeType names used in search-attributes.ts. */
export const INDEXED_VALUE_TYPE: Record<string, number> = {
  TEXT: 1,
  KEYWORD: 2,
  INT: 3,
  DOUBLE: 4,
  BOOL: 5,
  DATETIME: 6,
  KEYWORD_LIST: 7,
};

/** Readable name for an IndexedValueType number (for logs and CLI output). */
export function indexedValueTypeName(value: number): string {
  for (const [name, v] of Object.entries(INDEXED_VALUE_TYPE)) {
    if (v === value) return name;
  }
  return `UNSPECIFIED(${value})`;
}

/**
 * The slice of the gRPC OperatorService this module needs, typed structurally
 * so the worker's NativeConnection, the client Connection, and test fakes all
 * fit without importing generated proto types.
 */
export type OperatorServiceLike = {
  listSearchAttributes(request: { namespace: string }): Promise<{
    customAttributes?: Record<string, number> | null;
  }>;
  addSearchAttributes(request: {
    namespace: string;
    searchAttributes: Record<string, number>;
  }): Promise<unknown>;
};

export type EnsureSearchAttributesResult = {
  /** Registered by this call. */
  added: string[];
  /** Already registered with the wanted type (or an "already exists" race). */
  present: string[];
  /** Registered with a DIFFERENT type. Never auto-fixed: re-typing needs a
   * manual delete+recreate (or a rename in code). Executions that carry or
   * upsert these will be rejected until resolved. */
  mismatched: { name: string; registered: number; wanted: number }[];
  /** Adds that errored for other reasons (per-type caps, permissions). */
  failed: { name: string; error: unknown }[];
  /** listSearchAttributes is unimplemented (the time-skipping test server), so
   * adds ran blind against an assumed-empty namespace. */
  blind: boolean;
};

/** Walk an error's cause chain and report the first gRPC status code found. */
function grpcCode(err: unknown): number | null {
  for (let e = err, depth = 0; e != null && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "number") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  for (let e = err, depth = 0; e != null && depth < 5; depth++) {
    const details = (e as { details?: unknown }).details;
    const message = (e as { message?: unknown }).message;
    if (typeof details === "string") parts.push(details);
    if (typeof message === "string") parts.push(message);
    e = (e as { cause?: unknown }).cause;
  }
  return parts.join(" ");
}

/** gRPC ALREADY_EXISTS, or the older INVALID_ARGUMENT with an "already exists"
 * message: both mean someone (a racing replica, a previous deploy) registered
 * the attribute first, which is success for our purposes. */
function isAlreadyExists(err: unknown): boolean {
  if (grpcCode(err) === 6) return true;
  return /already exists/i.test(errorText(err));
}

/** gRPC UNIMPLEMENTED: the time-skipping test server has no
 * listSearchAttributes. */
function isUnimplemented(err: unknown): boolean {
  return grpcCode(err) === 12;
}

/**
 * Ensure every attribute in SEARCH_ATTRIBUTE_REGISTRATIONS exists on the
 * namespace. Never throws for a per-attribute problem (see the result shape);
 * throws only when the namespace cannot be inspected at all (e.g. the Operator
 * API is blocked, as on Temporal Cloud) so the caller can log one clear line.
 */
export async function ensureSearchAttributes(
  operator: OperatorServiceLike,
  namespace: string
): Promise<EnsureSearchAttributesResult> {
  let current: Record<string, number> | null = null;
  let blind = false;
  try {
    const res = await operator.listSearchAttributes({ namespace });
    current = {};
    for (const [name, type] of Object.entries(res.customAttributes ?? {})) {
      current[name] = Number(type);
    }
  } catch (e) {
    if (!isUnimplemented(e)) throw e;
    blind = true;
  }

  const result: EnsureSearchAttributesResult = {
    added: [],
    present: [],
    mismatched: [],
    failed: [],
    blind,
  };

  for (const { name, type } of SEARCH_ATTRIBUTE_REGISTRATIONS) {
    const wanted = INDEXED_VALUE_TYPE[type];
    if (wanted == null) throw new Error(`unmapped search attribute type: ${type}`);
    const registered = current?.[name];
    if (registered != null) {
      if (registered === wanted) result.present.push(name);
      else result.mismatched.push({ name, registered, wanted });
      continue;
    }
    try {
      await operator.addSearchAttributes({
        namespace,
        searchAttributes: { [name]: wanted },
      });
      result.added.push(name);
    } catch (e) {
      if (isAlreadyExists(e)) result.present.push(name);
      else result.failed.push({ name, error: e });
    }
  }

  return result;
}

/**
 * True when a start/signalWithStart RPC was rejected because of the request's
 * search attributes: gRPC INVALID_ARGUMENT whose message names a search
 * attribute ("search attribute ProjectId is not defined", "invalid value for
 * search attribute RepoId of type Keyword: ..."). The @temporalio/client
 * wraps the gRPC error in a ServiceError ("Failed to signalWithStart
 * Workflow"), so the code and message live on the cause chain.
 */
export function isSearchAttributeRejection(err: unknown): boolean {
  return grpcCode(err) === 3 && /search attribute/i.test(errorText(err));
}
