"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useActionFeedback } from "@/components/ui/use-action-feedback";
import { linkQaBoard, unlinkQaBoard } from "./actions";

export type BoardLinkRow = {
  id: string;
  provider: string;
  targetId: string;
  enabled: boolean;
  /** Whether the provider accepted a webhook, or we are polling only. */
  hooked: boolean;
  lastPulledAt: string | null;
  lastError: string | null;
};

const PROVIDERS = [
  {
    id: "notion" as const,
    label: "Notion",
    targetLabel: "Database ID",
    targetHint:
      "The 32-character id in the database URL. The database needs a select property called Status, and the integration has to be shared with it.",
    needsKey: false,
    tokenLabel: "Integration token",
  },
  {
    id: "trello" as const,
    label: "Trello",
    targetLabel: "Board ID",
    targetHint:
      "The board id from its URL. Lists named for each QA status are created if they do not exist, and moving a card between them is what records a verdict.",
    needsKey: true,
    tokenLabel: "Token",
  },
];

/**
 * Connect a repo's QA board to Notion or Trello.
 *
 * Credentials are write-only here: they go to the server and are never read
 * back, so an existing link shows what it points at and whether it is healthy,
 * never the token itself.
 */
export function BoardLinks({
  projectId,
  repoId,
  links,
  canManage,
}: {
  projectId: string;
  repoId: string;
  links: BoardLinkRow[];
  canManage: boolean;
}) {
  const [open, setOpen] = useState<"notion" | "trello" | null>(null);
  const [targetId, setTargetId] = useState("");
  const [token, setToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fb = useActionFeedback<string>();

  const byProvider = new Map(links.map((l) => [l.provider, l]));

  async function connect(provider: "notion" | "trello") {
    setError(null);
    const result = await fb.run(provider, () =>
      linkQaBoard({
        projectId,
        repoId,
        provider,
        targetId,
        token,
        apiKey: apiKey || undefined,
      }),
    );
    if (result.ok) {
      setOpen(null);
      setTargetId("");
      setToken("");
      setApiKey("");
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="space-y-4">
      {PROVIDERS.map((p) => {
        const link = byProvider.get(p.id);
        return (
          <div key={p.id} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{p.label}</span>
                {link ? (
                  <>
                    <Badge variant="success" className="text-[10px]">
                      Connected
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {link.hooked ? "Webhook + polling" : "Polling"}
                    </Badge>
                  </>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    Not connected
                  </Badge>
                )}
              </div>
              {canManage ? (
                link ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={fb.isLoading(`unlink-${p.id}`)}
                    onClick={() =>
                      fb.run(`unlink-${p.id}`, () =>
                        unlinkQaBoard({ projectId, linkId: link.id }),
                      )
                    }
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setOpen(open === p.id ? null : p.id)}
                  >
                    Connect
                  </Button>
                )
              ) : null}
            </div>

            {link ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                <span className="font-mono">{link.targetId}</span>
                {link.lastPulledAt ? ` · last synced ${link.lastPulledAt}` : null}
              </p>
            ) : null}

            {link?.lastError ? (
              <p className="mt-1.5 text-xs text-destructive-strong">
                Last sync failed: {link.lastError}
              </p>
            ) : null}

            {open === p.id && !link ? (
              <div className="mt-3 space-y-3 border-t border-border pt-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`target-${p.id}`}>{p.targetLabel}</Label>
                  <Input
                    id={`target-${p.id}`}
                    value={targetId}
                    onChange={(e) => setTargetId(e.target.value)}
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">{p.targetHint}</p>
                </div>
                {p.needsKey ? (
                  <div className="space-y-1.5">
                    <Label htmlFor={`key-${p.id}`}>API key</Label>
                    <Input
                      id={`key-${p.id}`}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <Label htmlFor={`token-${p.id}`}>{p.tokenLabel}</Label>
                  <Input
                    id={`token-${p.id}`}
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Stored on the server and never shown again.
                  </p>
                </div>
                {error ? (
                  <p className="text-xs text-destructive-strong">{error}</p>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    loading={fb.isLoading(p.id)}
                    disabled={!targetId || !token || (p.needsKey && !apiKey)}
                    onClick={() => connect(p.id)}
                  >
                    Connect
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setOpen(null);
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
