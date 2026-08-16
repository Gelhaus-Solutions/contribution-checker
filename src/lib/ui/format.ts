/**
 * Date formatting for the UI.
 *
 * Everything here formats in UTC, deliberately. Two reasons: this is a
 * maintainer tool where dates need to be stable and copy-pasteable between an
 * audit log, a GitHub comment and a database row, and a locale- or
 * timezone-dependent string rendered on the server would not match the same
 * string re-rendered on the client. The app currently avoids that class of
 * hydration bug by accident, via .toISOString().slice(0, 10) repeated in 19
 * places; this keeps the property on purpose.
 *
 * The three call sites that build GitHub comment text (check-run.ts,
 * decision-message.ts, decide.ts) stay on the raw form: their output is
 * published to GitHub, not rendered here.
 */

type DateInput = Date | string | number | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `2026-08-16`. The default for anything shown in a list or a table. */
export function formatDate(value: DateInput, fallback = "n/a"): string {
  const d = toDate(value);
  return d ? d.toISOString().slice(0, 10) : fallback;
}

/** `2026-08-16 19:45`. For audit trails and PR timelines. */
export function formatDateTime(value: DateInput, fallback = "n/a"): string {
  const d = toDate(value);
  return d ? d.toISOString().slice(0, 16).replace("T", " ") : fallback;
}

/** `2026-08-16 19:45:52`. Only where the second actually matters. */
export function formatDateTimeSeconds(
  value: DateInput,
  fallback = "n/a",
): string {
  const d = toDate(value);
  return d ? d.toISOString().slice(0, 19).replace("T", " ") : fallback;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `3d ago`. For the notification inbox, where recency is the point.
 *
 * Takes an explicit `now` so it stays a pure function and so tests do not
 * depend on the clock.
 */
export function formatRelative(
  value: DateInput,
  now: DateInput = new Date(),
  fallback = "n/a",
): string {
  const d = toDate(value);
  const ref = toDate(now);
  if (!d || !ref) return fallback;

  const diff = ref.getTime() - d.getTime();
  if (diff < 0) return "just now";
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  // Past a month a relative string stops being useful, so show the date.
  return formatDate(d, fallback);
}
