import { Markdown } from "@/components/markdown";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { editNoteAction, deleteNoteAction } from "../actions";

export type NoteCardData = {
  id: string;
  body: string;
  visibility: "INTERNAL" | "APPLICANT" | string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  author: { id?: string; ghLogin: string | null };
};

function isEdited(n: { createdAt: Date; updatedAt: Date }) {
  // Prisma sets updatedAt = now() on create, so equality with createdAt
  // means "not edited". Fudge by 1s to absorb clock drift on backfilled rows.
  return n.updatedAt.getTime() - n.createdAt.getTime() > 1000;
}

export function NoteCard({
  note,
  projectId,
  appId,
  viewer,
  context = "internal",
}: {
  note: NoteCardData;
  projectId: string;
  appId: string;
  viewer: {
    userId: string;
    canModerate: boolean; // ADMIN+
    isApplicant: boolean;
  };
  context?: "internal" | "applicant";
}) {
  const isOwn = note.author.id === viewer.userId;
  const isDeleted = !!note.deletedAt;
  const canEdit = isOwn && !isDeleted;
  const canDelete = (isOwn || viewer.canModerate) && !isDeleted;

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="font-medium text-foreground">
            @{note.author.ghLogin ?? "unknown"}
          </span>
          <span>·</span>
          <span>{note.createdAt.toISOString().replace("T", " ").slice(0, 16)}</span>
          {isEdited(note) && !isDeleted && (
            <span title={`edited ${note.updatedAt.toISOString()}`}>(edited)</span>
          )}
          {context === "internal" && note.visibility === "APPLICANT" && (
            <Badge variant="warning" className="text-[10px]">
              visible to applicant
            </Badge>
          )}
        </div>
        {(canEdit || canDelete) && (
          <div className="flex items-center gap-1">
            {canEdit && (
              <details className="inline">
                <summary className="cursor-pointer text-muted-foreground hover:underline">
                  edit
                </summary>
                <form action={editNoteAction} className="mt-2 space-y-2">
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="appId" value={appId} />
                  <input type="hidden" name="noteId" value={note.id} />
                  <Textarea
                    name="body"
                    rows={3}
                    required
                    defaultValue={note.body}
                  />
                  <SubmitButton size="sm" variant="outline">
                    Save
                  </SubmitButton>
                </form>
              </details>
            )}
            {canDelete && (
              <form action={deleteNoteAction} className="inline">
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="appId" value={appId} />
                <input type="hidden" name="noteId" value={note.id} />
                <button
                  type="submit"
                  className="text-muted-foreground hover:text-destructive hover:underline"
                >
                  delete
                </button>
              </form>
            )}
          </div>
        )}
      </div>
      {isDeleted ? (
        <div className="text-muted-foreground italic">
          [deleted{note.deletedAt ? ` ${note.deletedAt.toISOString().slice(0, 10)}` : ""}]
        </div>
      ) : (
        <Markdown source={note.body} />
      )}
    </div>
  );
}
