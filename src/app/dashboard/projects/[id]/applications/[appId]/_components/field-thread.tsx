import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { addFieldCommentAction, replyToCommentAction } from "../actions";
import { NoteCard, type NoteCardData } from "./note-card";

export type FieldThreadNote = NoteCardData & {
  parentId: string | null;
  reviewId: string | null;
  fieldId: string | null;
};

/**
 * Renders all comments anchored to a specific form field as a threaded
 * conversation, plus a "draft a comment" form. Drafts (reviewId=null) are
 * marked accordingly so the author knows they'll be attached to the next
 * submitted review.
 */
export function FieldThread({
  fieldId,
  notes,
  projectId,
  appId,
  viewer,
}: {
  fieldId: string;
  notes: FieldThreadNote[];
  projectId: string;
  appId: string;
  viewer: { userId: string; canModerate: boolean; isApplicant: boolean };
}) {
  const fieldNotes = notes.filter(
    (n) => n.fieldId === fieldId && n.parentId === null,
  );
  const repliesByParent = new Map<string, FieldThreadNote[]>();
  for (const n of notes) {
    if (n.parentId) {
      const list = repliesByParent.get(n.parentId) ?? [];
      list.push(n);
      repliesByParent.set(n.parentId, list);
    }
  }

  const visibleCount = fieldNotes.length;

  return (
    <details className="mt-2 group">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
        💬 {visibleCount === 0 ? "Add comment" : `${visibleCount} comment${visibleCount === 1 ? "" : "s"}`}
      </summary>
      <div className="mt-2 space-y-2 border-l-2 border-border pl-3">
        {fieldNotes.map((n) => (
          <ThreadedNote
            key={n.id}
            note={n}
            replies={repliesByParent.get(n.id) ?? []}
            projectId={projectId}
            appId={appId}
            viewer={viewer}
          />
        ))}
        <form action={addFieldCommentAction} className="space-y-2 pt-1">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="appId" value={appId} />
          <input type="hidden" name="fieldId" value={fieldId} />
          <Textarea
            name="body"
            rows={2}
            required
            placeholder="Draft a comment on this field… (markdown supported)"
          />
          <div className="flex items-center gap-2">
            <SubmitButton size="sm" variant="outline">
              Add to next review
            </SubmitButton>
            <span className="text-[11px] text-muted-foreground">
              Drafts are private until you submit a review.
            </span>
          </div>
        </form>
      </div>
    </details>
  );
}

function ThreadedNote({
  note,
  replies,
  projectId,
  appId,
  viewer,
}: {
  note: FieldThreadNote;
  replies: FieldThreadNote[];
  projectId: string;
  appId: string;
  viewer: { userId: string; canModerate: boolean; isApplicant: boolean };
}) {
  const draftBadge =
    note.reviewId === null && note.author.id === viewer.userId ? (
      <Badge variant="outline" className="text-[10px]">
        draft
      </Badge>
    ) : null;
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {draftBadge && <div>{draftBadge}</div>}
        <NoteCard
          note={note}
          projectId={projectId}
          appId={appId}
          viewer={viewer}
        />
      </div>
      {replies.length > 0 && (
        <div className="ml-4 space-y-2">
          {replies.map((r) => (
            <NoteCard
              key={r.id}
              note={r}
              projectId={projectId}
              appId={appId}
              viewer={viewer}
            />
          ))}
        </div>
      )}
      <form action={replyToCommentAction} className="ml-4 space-y-1">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="appId" value={appId} />
        <input type="hidden" name="parentId" value={note.id} />
        <Textarea
          name="body"
          rows={1}
          required
          placeholder="Reply…"
          className="text-xs"
        />
        <SubmitButton size="sm" variant="outline">
          Reply
        </SubmitButton>
      </form>
    </div>
  );
}
