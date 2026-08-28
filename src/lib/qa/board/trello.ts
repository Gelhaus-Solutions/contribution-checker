import {
  decodeStatus,
  parseStatusMap,
  truncate,
  type BoardAdapter,
  type BoardCardPayload,
  type BoardLink,
  type ExternalVerdict,
} from "@/lib/qa/board/types";

/**
 * Trello adapter. One card per QA item, and the status is which list it sits in.
 *
 * `targetId` is the **board** id, not a list id, and the status map holds list
 * names. Modelling status as list membership rather than as a label is the
 * point: dragging a card from "Not verified" to "Verified" is what people
 * actually do on a Trello QA board, and anything else would leave the mirror
 * fighting the muscle memory of everyone using it.
 *
 * Lists are resolved by name and created when missing, so linking a fresh board
 * produces a usable one rather than an error about a list nobody made yet.
 */

const API = "https://api.trello.com/1";

const NAME_MAX = 16384;
const DESC_MAX = 16384;

function auth(link: BoardLink): string {
  // Trello wants both the application key and the user token on every call.
  return `key=${encodeURIComponent(link.apiKey ?? "")}&token=${encodeURIComponent(link.token)}`;
}

async function trelloFetch(
  link: BoardLink,
  path: string,
  init: { method: string; query?: Record<string, string> },
): Promise<unknown> {
  const query = new URLSearchParams(init.query ?? {}).toString();
  const url = `${API}${path}?${auth(link)}${query ? `&${query}` : ""}`;
  const res = await fetch(url, { method: init.method });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Trello ${init.method} ${path} failed: ${res.status} ${detail.slice(0, 300)}`,
    );
  }
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type TrelloList = { id?: unknown; name?: unknown };
type TrelloCard = {
  id?: unknown;
  url?: unknown;
  shortUrl?: unknown;
  idList?: unknown;
  dateLastActivity?: unknown;
};

/**
 * Board lists by name, creating any the status map needs.
 *
 * Cached per call rather than per process: a list renamed in Trello has to be
 * picked up on the next sync, and a stale cache here would quietly file every
 * card into the wrong column.
 */
async function resolveLists(
  link: BoardLink,
  wanted: string[],
): Promise<Map<string, string>> {
  const lists = (await trelloFetch(link, `/boards/${link.targetId}/lists`, {
    method: "GET",
    query: { fields: "id,name" },
  })) as TrelloList[] | null;

  const byName = new Map<string, string>();
  for (const list of lists ?? []) {
    if (typeof list.id === "string" && typeof list.name === "string") {
      byName.set(list.name.trim().toLowerCase(), list.id);
    }
  }

  for (const name of wanted) {
    if (byName.has(name.trim().toLowerCase())) continue;
    const created = (await trelloFetch(link, "/lists", {
      method: "POST",
      query: { name, idBoard: link.targetId },
    })) as TrelloList | null;
    if (created && typeof created.id === "string") {
      byName.set(name.trim().toLowerCase(), created.id);
    }
  }
  return byName;
}

/** The card body. Trello has no fields, so the detail goes in the description. */
function description(payload: BoardCardPayload): string {
  const parts: string[] = [];
  if (payload.url) parts.push(payload.url);
  if (payload.summary) parts.push(payload.summary);
  if (payload.qaSteps) parts.push(`**How to test**\n\n${payload.qaSteps}`);
  if (payload.notes) parts.push(`**Notes**\n\n${payload.notes}`);
  return truncate(parts.join("\n\n"), DESC_MAX) ?? "";
}

async function listIdFor(
  link: BoardLink,
  payload: BoardCardPayload,
): Promise<string | null> {
  const map = parseStatusMap(JSON.stringify(link.statusMap));
  const lists = await resolveLists(link, Object.values(map));
  return lists.get(map[payload.status].trim().toLowerCase()) ?? null;
}

export const trelloAdapter: BoardAdapter = {
  provider: "trello",

  async createCard(link, payload) {
    const idList = await listIdFor(link, payload);
    if (!idList) throw new Error("Could not resolve a Trello list for that status");
    const card = (await trelloFetch(link, "/cards", {
      method: "POST",
      query: {
        idList,
        name: truncate(payload.title, NAME_MAX) ?? "Untitled",
        desc: description(payload),
      },
    })) as TrelloCard | null;
    const id = card && typeof card.id === "string" ? card.id : null;
    if (!id) throw new Error("Trello returned a card with no id");
    const url =
      card && typeof card.shortUrl === "string"
        ? card.shortUrl
        : typeof card?.url === "string"
          ? (card.url as string)
          : `https://trello.com/c/${id}`;
    return { externalId: id, externalUrl: url };
  },

  async updateCard(link, externalId, payload) {
    const idList = await listIdFor(link, payload);
    await trelloFetch(link, `/cards/${externalId}`, {
      method: "PUT",
      query: {
        name: truncate(payload.title, NAME_MAX) ?? "Untitled",
        desc: description(payload),
        ...(idList ? { idList } : {}),
      },
    });
  },

  async archiveCard(link, externalId) {
    await trelloFetch(link, `/cards/${externalId}`, {
      method: "PUT",
      query: { closed: "true" },
    });
  },

  async pullChanges(link, since) {
    const map = parseStatusMap(JSON.stringify(link.statusMap));
    const lists = await resolveLists(link, Object.values(map));
    // list id -> list name, so a card's column decodes back to a status.
    const nameById = new Map<string, string>();
    for (const [name, id] of lists) nameById.set(id, name);

    const cards = (await trelloFetch(link, `/boards/${link.targetId}/cards`, {
      method: "GET",
      query: { fields: "id,idList,dateLastActivity", filter: "open" },
    })) as TrelloCard[] | null;

    const out: ExternalVerdict[] = [];
    for (const card of cards ?? []) {
      if (typeof card.id !== "string") continue;
      const editedAt =
        typeof card.dateLastActivity === "string"
          ? new Date(card.dateLastActivity)
          : null;
      if (!editedAt || Number.isNaN(editedAt.getTime())) continue;
      // Trello has no server-side "changed since" filter for cards, so the
      // window is applied here. One board read either way.
      if (since && editedAt <= since) continue;
      const listName =
        typeof card.idList === "string" ? nameById.get(card.idList) : null;
      out.push({
        externalId: card.id,
        status: decodeStatus(map, listName ?? null),
        // Trello does not name the last editor on the card, and fetching the
        // action that moved it would be one request per card. The board is the
        // attribution.
        actor: "Trello",
        editedAt,
      });
    }
    return out;
  },

  async registerHook(link, callbackUrl) {
    const hook = (await trelloFetch(link, "/webhooks", {
      method: "POST",
      query: { callbackURL: callbackUrl, idModel: link.targetId },
    })) as { id?: unknown } | null;
    return hook && typeof hook.id === "string" ? hook.id : null;
  },

  async unregisterHook(link) {
    // The caller holds the id; nothing to do when there is none.
    return;
  },

  async verify(link) {
    if (!link.apiKey) {
      return { ok: false, error: "Trello needs an API key alongside the token." };
    }
    try {
      await trelloFetch(link, `/boards/${link.targetId}`, {
        method: "GET",
        query: { fields: "id,name" },
      });
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Trello rejected the request.",
      };
    }
  },
};
