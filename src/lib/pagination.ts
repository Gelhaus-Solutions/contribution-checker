// Shared helpers for server-side, URL-driven list pagination + search.
// Pages read the awaited `searchParams`, call parsePageParams to derive
// skip/take/q, and pass the same searchParams object to <Pagination> and
// <SearchInput> so sibling params (status tabs, sibling paginators) ride along.

export const DEFAULT_PER_PAGE = 25;
export const MAX_PER_PAGE = 100;

export type SearchParamRecord = Record<string, string | string[] | undefined>;

// Param key names. Override (e.g. { page: "spage", q: "sq" }) when a single
// route hosts more than one independent paginator.
export type PageKeys = { page: string; perPage: string; q: string };
const DEFAULT_KEYS: PageKeys = { page: "page", perPage: "perPage", q: "q" };

export type PageParams = {
  page: number;
  perPage: number;
  skip: number;
  take: number;
  q: string;
};

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parsePageParams(
  sp: SearchParamRecord,
  opts?: { defaultPerPage?: number; keys?: Partial<PageKeys> }
): PageParams {
  const keys = { ...DEFAULT_KEYS, ...opts?.keys };

  const rawPage = Number(first(sp[keys.page]));
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const defaultPerPage = opts?.defaultPerPage ?? DEFAULT_PER_PAGE;
  const rawPerPage = Number(first(sp[keys.perPage]));
  const perPage =
    Number.isFinite(rawPerPage) && rawPerPage >= 1
      ? Math.min(Math.floor(rawPerPage), MAX_PER_PAGE)
      : defaultPerPage;

  const q = (first(sp[keys.q]) ?? "").trim();

  return { page, perPage, skip: (page - 1) * perPage, take: perPage, q };
}

export function totalPages(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage));
}

// Flatten the current params to a string map, dropping the given keys. Used to
// preserve sibling state (other paginators on the same route) as hidden inputs
// in a search form. The form drops its own page key, resetting it to page 1.
export function siblingParams(
  sp: SearchParamRecord,
  exclude: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(sp)) {
    if (exclude.includes(key)) continue;
    const v = first(value);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

// Build an href that preserves every current param, patching only the page key
// (dropped entirely when targeting page 1, for clean URLs).
export function buildPageHref(
  pathname: string,
  current: SearchParamRecord,
  page: number,
  keys?: Partial<PageKeys>
): string {
  const k = { ...DEFAULT_KEYS, ...keys };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    if (value === undefined || key === k.page) continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else {
      params.set(key, value);
    }
  }
  if (page > 1) params.set(k.page, String(page));
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
