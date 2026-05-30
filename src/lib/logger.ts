import pino from "pino";
import * as Sentry from "@sentry/nextjs";
import { env } from "./env";

const VALID_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
type Level = (typeof VALID_LEVELS)[number];

const level: Level = VALID_LEVELS.includes(env.LOG_LEVEL as Level)
  ? (env.LOG_LEVEL as Level)
  : "info";

const pinoLogger = pino({
  level,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

// Tag every log/metric with the runtime so dashboards can split webhook vs UI.
const runtimeTag: Record<string, string> = {
  "service.name": "contribution-checker",
  "service.runtime": process.env.NEXT_RUNTIME ?? "nodejs",
};

type LogPayload = Record<string, unknown> | string | undefined;

function splitErrAndAttrs(arg: LogPayload, msg?: string): {
  err: unknown;
  message: string;
  attrs: Record<string, unknown>;
} {
  if (typeof arg === "string") {
    return { err: undefined, message: arg, attrs: {} };
  }
  if (!arg || typeof arg !== "object") {
    return { err: undefined, message: msg ?? "", attrs: {} };
  }
  const { err, error, ...rest } = arg as Record<string, unknown> & {
    err?: unknown;
    error?: unknown;
  };
  return {
    err: err ?? error,
    message: msg ?? "",
    attrs: rest,
  };
}

function toSentryAttrs(
  attrs: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { ...runtimeTag };
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      // Stringify nested structures so they survive Sentry's attribute shape.
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = String(v);
      }
    }
  }
  return out;
}

// Sentry's logs API uses 'warn'/'error'/'fatal'/'info', while its issue
// severity uses 'warning' instead of 'warn'. Map between the two.
type LogLevel = "info" | "warn" | "error" | "fatal";
const ISSUE_SEVERITY: Record<LogLevel, Sentry.SeverityLevel> = {
  info: "info",
  warn: "warning",
  error: "error",
  fatal: "fatal",
};

function captureToSentry(
  logLevel: LogLevel,
  err: unknown,
  message: string,
  attrs: Record<string, unknown>,
): void {
  const sentryAttrs = toSentryAttrs(attrs);
  const issueLevel = ISSUE_SEVERITY[logLevel];

  // Sentry logs product: every log line above debug becomes a structured log
  // event with the same attributes as the metric/issue. `enableLogs: true` in
  // sentry.server.config.ts gates whether these get shipped.
  try {
    const logFn = Sentry.logger[logLevel as keyof typeof Sentry.logger];
    if (typeof logFn === "function") {
      // The Sentry log API is (message, attributes). Attach the error string
      // into attrs so it shows up next to the log entry too.
      const enriched: Record<string, unknown> = { ...sentryAttrs };
      if (err) {
        enriched["error.message"] =
          err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.name) {
          enriched["error.type"] = err.name;
        }
      }
      (logFn as (m: string, a?: Record<string, unknown>) => void)(
        message || (err instanceof Error ? err.message : "log"),
        enriched,
      );
    }
  } catch {
    // never let observability break the request
  }

  // Issue capture: warn/error/fatal raise events too. For warn-without-Error
  // we skip captureMessage so the Errors view stays focused on actual errors.
  try {
    if (err instanceof Error) {
      Sentry.captureException(err, {
        level: issueLevel,
        tags: { "log.message": message.slice(0, 200) },
        extra: sentryAttrs,
      });
    } else if (logLevel === "error" || logLevel === "fatal") {
      Sentry.captureMessage(message || "logged error", {
        level: issueLevel,
        extra: sentryAttrs,
      });
    }
  } catch {
    // swallow; logging must never throw
  }
}

function makeMethod(pinoLevel: Level, logLevel: LogLevel | null) {
  return (arg: LogPayload, msg?: string) => {
    // Always emit to pino first so stdout/file sinks get every log.
    (pinoLogger[pinoLevel] as (...a: unknown[]) => void)(
      arg as never,
      msg as never,
    );

    // debug/trace deliberately do NOT go to Sentry; they are local-only.
    if (!logLevel) return;

    const parts = splitErrAndAttrs(arg, msg);
    captureToSentry(logLevel, parts.err, parts.message, parts.attrs);
  };
}

/**
 * Application logger. Routes log lines to:
 *   - pino (stdout, plus pino-pretty in dev)
 *   - Sentry logs (info/warn/error/fatal), via Sentry.logger.*
 *   - Sentry issues (warn/error/fatal), via captureException/captureMessage
 *   - Sentry metrics (info/warn/error/fatal), via the `app.log` counter
 *
 * debug and trace are local-only by design because they are too noisy for Sentry
 * and would blow through any sampling/retention budget.
 */
export const logger = {
  fatal: makeMethod("fatal", "fatal"),
  error: makeMethod("error", "error"),
  warn: makeMethod("warn", "warn"),
  info: makeMethod("info", "info"),
  debug: makeMethod("debug", null),
  trace: makeMethod("trace", null),
};

export type AppLogger = typeof logger;
