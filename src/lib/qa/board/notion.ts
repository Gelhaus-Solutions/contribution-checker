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
 * Notion adapter. One page per QA item in a target database.
 *
 * `targetId` is the database id. The status lives in a select property named
 * `Status`, whose option names come from the link's status map.
 *
 * Notion has no per-database webhook: its webhooks are workspace-scoped and
 * configured in Notion's own UI, not by an integration. `registerHook` returns
 * null and the poll carries the whole job, which is why the sync was built as a
 * reconciling read rather than an event handler in the first place.
 */

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

const TITLE_MAX = 200;
const TEXT_MAX = 1800;

/** Notion rejects the whole request when a rich_text block exceeds 2000 chars. */
function richText(value: string | null) {
  const text = truncate(value, TEXT_MAX);
  return text ? [{ type: "text", text: { content: text } }] : [];
}

async function notionFetch(
  link: BoardLink,
  path: string,
  init: { method: string; body?: unknown },
): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${link.token}`,
      "Notion-Version": VERSION,
      "Content-Type": "application/json",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!res.ok) {
    // Notion puts a usable message in the body; surfacing it is the difference
    // between "sync failed" and "your Status property has no option called
    // Verified".
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Notion ${init.method} ${path} failed: ${res.status} ${detail.slice(0, 300)}`,
    );
  }
  return res.json();
}

function properties(link: BoardLink, payload: BoardCardPayload) {
  const map = parseStatusMap(JSON.stringify(link.statusMap));
  return {
    Name: { title: richText(truncate(payload.title, TITLE_MAX) ?? "Untitled") },
    Status: { select: { name: map[payload.status] } },
    ...(payload.url ? { URL: { url: payload.url } } : {}),
    Summary: { rich_text: richText(payload.summary) },
    "QA steps": { rich_text: richText(payload.qaSteps) },
    Notes: { rich_text: richText(payload.notes) },
  };
}

type NotionPage = {
  id?: unknown;
  url?: unknown;
  last_edited_time?: unknown;
  last_edited_by?: { id?: unknown; name?: unknown };
  properties?: Record<string, { select?: { name?: unknown } }>;
};

export const notionAdapter: BoardAdapter = {
  provider: "notion",

  async createCard(link, payload) {
    const page = (await notionFetch(link, "/pages", {
      method: "POST",
      body: {
        parent: { database_id: link.targetId },
        properties: properties(link, payload),
      },
    })) as NotionPage;
    const id = typeof page.id === "string" ? page.id : null;
    if (!id) throw new Error("Notion returned a page with no id");
    return {
      externalId: id,
      externalUrl:
        typeof page.url === "string"
          ? page.url
          : `https://notion.so/${id.replace(/-/g, "")}`,
    };
  },

  async updateCard(link, externalId, payload) {
    await notionFetch(link, `/pages/${externalId}`, {
      method: "PATCH",
      body: { properties: properties(link, payload) },
    });
  },

  async archiveCard(link, externalId) {
    await notionFetch(link, `/pages/${externalId}`, {
      method: "PATCH",
      body: { archived: true },
    });
  },

  async pullChanges(link, since) {
    const map = parseStatusMap(JSON.stringify(link.statusMap));
    const body: Record<string, unknown> = { page_size: 100 };
    if (since) {
      body.filter = {
        timestamp: "last_edited_time",
        last_edited_time: { on_or_after: since.toISOString() },
      };
    }
    const res = (await notionFetch(link, `/databases/${link.targetId}/query`, {
      method: "POST",
      body,
    })) as { results?: NotionPage[] };

    const out: ExternalVerdict[] = [];
    for (const page of res.results ?? []) {
      const id = typeof page.id === "string" ? page.id : null;
      if (!id) continue;
      const raw = page.properties?.Status?.select?.name;
      const editedAt =
        typeof page.last_edited_time === "string"
          ? new Date(page.last_edited_time)
          : null;
      if (!editedAt || Number.isNaN(editedAt.getTime())) continue;
      out.push({
        externalId: id,
        status: decodeStatus(map, typeof raw === "string" ? raw : null),
        actor:
          typeof page.last_edited_by?.name === "string"
            ? page.last_edited_by.name
            : null,
        editedAt,
      });
    }
    return out;
  },

  async registerHook() {
    // Not available to an integration on a per-database basis. The poll is the
    // mechanism here, by design.
    return null;
  },

  async unregisterHook() {
    // Nothing was registered, so nothing to remove.
  },

  async verify(link) {
    try {
      const db = (await notionFetch(link, `/databases/${link.targetId}`, {
        method: "GET",
      })) as { properties?: Record<string, { type?: unknown }> };
      const status = db.properties?.Status;
      if (!status) {
        return {
          ok: false,
          error:
            "That database has no `Status` property. Add a select property called Status.",
        };
      }
      if (status.type !== "select") {
        return {
          ok: false,
          error: "The `Status` property has to be a select, not a " + String(status.type) + ".",
        };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Notion rejected the request." };
    }
  },
};
