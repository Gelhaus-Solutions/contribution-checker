import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { SubmitButton } from "@/components/ui/submit-button";
import { dismissReviewAction } from "../actions";

export type ReviewListItem = {
  id: string;
  state: string;
  body: string | null;
  visibility: string;
  submittedAt: Date;
  deletedAt: Date | null;
  author: { ghLogin: string | null };
  commentCount: number;
};

const STATE_VARIANT: Record<
  string,
  "default" | "secondary" | "success" | "warning" | "destructive" | "outline"
> = {
  APPROVED: "success",
  CHANGES_REQUESTED: "warning",
  COMMENTED: "secondary",
};

const STATE_LABEL: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Commented",
};

export function ReviewsList({
  reviews,
  projectId,
  appId,
  canDismiss,
}: {
  reviews: ReviewListItem[];
  projectId: string;
  appId: string;
  canDismiss: boolean;
}) {
  if (reviews.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No reviews yet. Reviewers can submit Approve / Request Changes /
        Comment via the composer below.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {reviews.map((r) => {
        const isDismissed = !!r.deletedAt;
        return (
          <li
            key={r.id}
            className={
              "rounded-md border border-border bg-muted/20 p-3 text-sm" +
              (isDismissed ? " opacity-60" : "")
            }
          >
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <Badge
                  variant={STATE_VARIANT[r.state] ?? "outline"}
                  className="text-[10px]"
                >
                  {STATE_LABEL[r.state] ?? r.state}
                </Badge>
                <span className="font-medium">@{r.author.ghLogin ?? "unknown"}</span>
                <span className="text-muted-foreground">
                  {r.submittedAt.toISOString().replace("T", " ").slice(0, 16)}
                </span>
                {r.visibility === "APPLICANT" && !isDismissed && (
                  <Badge variant="warning" className="text-[10px]">
                    visible to applicant
                  </Badge>
                )}
                {isDismissed && (
                  <Badge variant="outline" className="text-[10px]">
                    dismissed
                  </Badge>
                )}
              </div>
              {canDismiss && !isDismissed && (
                <form action={dismissReviewAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="appId" value={appId} />
                  <input type="hidden" name="reviewId" value={r.id} />
                  <SubmitButton size="sm" variant="outline">
                    Dismiss
                  </SubmitButton>
                </form>
              )}
            </div>
            {r.body ? (
              <Markdown source={r.body} />
            ) : (
              <p className="text-xs text-muted-foreground italic">
                (no summary)
              </p>
            )}
            {r.commentCount > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {r.commentCount} field comment{r.commentCount === 1 ? "" : "s"}{" "}
                attached
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
