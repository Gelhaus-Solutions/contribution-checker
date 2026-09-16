/**
 * Every PR label the bot owns, and the one rule that holds across all of them:
 * no two may share a name.
 *
 * Two features pointing at one label means one of them silently stops being
 * able to find its own PRs, and the damage is invisible until somebody notices
 * a release that never got batched or a gate that stopped closing anything.
 *
 * The labels are spread across three settings forms (the gate labels on
 * Settings, the staging labels on Staging, the QA and guard labels on their own
 * cards), so every form has to check the collision against the labels it is not
 * editing. That used to be an array literal per form, which meant a new label
 * column had to be remembered in three places or the check quietly stopped
 * covering it. The catalog below is the single place instead: adding a column
 * here makes every form enforce it.
 */

import { prisma } from "@/lib/db";

/** Every label column on `Project`, with the form that edits it. */
export const LABEL_COLUMNS = [
  "labelPending",
  "labelApproved",
  "labelDenied",
  "labelEvaluate",
  "labelStagingBatch",
  "labelStagingIgnore",
  "labelStagingRepoint",
  "qaFailedLabel",
  "labelGuardUnlock",
  "labelGuardBlocked",
] as const;

export type LabelColumn = (typeof LABEL_COLUMNS)[number];

/** Prisma `select` covering every label column. */
export const labelColumnSelect = Object.fromEntries(
  LABEL_COLUMNS.map((c) => [c, true]),
) as Record<LabelColumn, true>;

/**
 * Throw unless the labels this form is submitting are distinct from each other
 * and from every label the project holds that the form is not editing.
 *
 * `submitted` carries only the columns the caller is about to write; everything
 * else is read from the row. Comparison is case-insensitive because GitHub
 * label names are: `Staging:Batch` and `staging:batch` are one label, and
 * letting both be stored would produce exactly the silent collision this
 * prevents.
 */
export async function assertLabelsUnique(
  projectId: string,
  submitted: Partial<Record<LabelColumn, string>>,
): Promise<void> {
  const current = await prisma.project.findUnique({
    where: { id: projectId },
    select: labelColumnSelect,
  });
  if (!current) throw new Error("Project not found");

  const effective = { ...current, ...submitted } as Record<LabelColumn, string>;
  const seen = new Map<string, LabelColumn>();
  for (const column of LABEL_COLUMNS) {
    const key = (effective[column] ?? "").trim().toLowerCase();
    if (!key) continue;
    const clash = seen.get(key);
    if (clash) {
      throw new Error(
        `The label "${effective[column]}" is already used by another setting (${LABEL_DESCRIPTIONS[clash]}). Every label the bot manages must have its own name.`,
      );
    }
    seen.set(key, column);
  }
}

/** Human names for the error message, so it says which other setting clashed
 * rather than printing a column name at somebody. */
const LABEL_DESCRIPTIONS: Record<LabelColumn, string> = {
  labelPending: "the pending PR label",
  labelApproved: "the approved PR label",
  labelDenied: "the denied PR label",
  labelEvaluate: "the re-evaluate label",
  labelStagingBatch: "the staging batch label",
  labelStagingIgnore: "the staging ignore label",
  labelStagingRepoint: "the staging repoint label",
  qaFailedLabel: "the QA failed label",
  labelGuardUnlock: "the guard unlock label",
  labelGuardBlocked: "the guard blocked label",
};
