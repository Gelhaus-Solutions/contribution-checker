import { z } from "zod";
import { RegexTimeoutError, safeRegexTest } from "@/lib/safe-regex";

const URL_FIELD_DEFAULT_MAX = 2000;
const URL_FIELD_HARD_MAX = 4000;

export const fieldIdSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9_]+$/i, "alphanumeric + underscore only");

export const baseFieldSchema = z.object({
  id: fieldIdSchema,
  label: z.string().min(1).max(120),
  required: z.boolean().default(false),
  helpText: z.string().max(500).optional(),
});

const urlPatternSchema = z
  .object({
    pattern: z.string().min(1).max(500).refine(
      (s) => {
        try {
          new RegExp(s);
          return true;
        } catch {
          return false;
        }
      },
      { message: "must be a valid regular expression" }
    ),
    mode: z.enum(["must-match", "must-not-match"]).default("must-match"),
    message: z.string().max(200).optional(),
  })
  .optional();

export const textFieldSchema = baseFieldSchema.extend({
  type: z.enum(["text", "textarea", "url"]),
  placeholder: z.string().max(120).optional(),
  maxLength: z.number().int().positive().max(10000).optional(),
  urlPattern: urlPatternSchema,
});

export const selectFieldSchema = baseFieldSchema.extend({
  type: z.literal("select"),
  options: z
    .array(
      z.object({
        value: z.string().min(1).max(80),
        label: z.string().min(1).max(120),
      })
    )
    .min(1)
    .max(50),
});

export const checkboxFieldSchema = baseFieldSchema.extend({
  type: z.literal("checkbox"),
});

export const fieldSchema = z.discriminatedUnion("type", [
  textFieldSchema,
  selectFieldSchema,
  checkboxFieldSchema,
]);

export const formSchema = z.array(fieldSchema).max(40);

export type Field = z.infer<typeof fieldSchema>;
export type FormSchema = z.infer<typeof formSchema>;

export function parseFormSchema(json: string): FormSchema {
  try {
    const parsed = JSON.parse(json);
    return formSchema.parse(parsed);
  } catch {
    return [];
  }
}

/** Build a Zod schema for the *answers* object based on the form schema. */
export function buildAnswersSchema(fields: FormSchema) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) {
    let s: z.ZodTypeAny;
    switch (f.type) {
      case "text":
      case "textarea":
        s = z.string().max(f.maxLength ?? 4000);
        if (f.required) s = (s as z.ZodString).min(1, "required");
        break;
      case "url": {
        const urlMax = Math.min(
          f.maxLength ?? URL_FIELD_DEFAULT_MAX,
          URL_FIELD_HARD_MAX
        );
        let urlString: z.ZodTypeAny = z.string().url().max(urlMax);
        if (f.urlPattern) {
          const pattern = f.urlPattern.pattern;
          const mustMatch = f.urlPattern.mode !== "must-not-match";
          const msg =
            f.urlPattern.message ??
            (mustMatch
              ? "URL does not match the required pattern"
              : "URL matches a disallowed pattern");
          urlString = (urlString as z.ZodString).refine(
            (v) => {
              try {
                const matched = safeRegexTest({ pattern, input: v });
                return mustMatch ? matched : !matched;
              } catch (e) {
                if (e instanceof RegexTimeoutError) return false;
                throw e;
              }
            },
            { message: msg }
          );
        }
        s = urlString;
        if (!f.required) s = s.optional().or(z.literal(""));
        break;
      }
      case "select":
        s = z.enum(f.options.map((o) => o.value) as [string, ...string[]]);
        if (!f.required) s = s.optional();
        break;
      case "checkbox":
        s = z.boolean();
        if (f.required) s = s.refine((v) => v === true, "required");
        break;
    }
    shape[f.id] = s;
  }
  return z.object(shape);
}

// ----- Review-process schemas (server-action input validation) -----

const NOTE_BODY_MAX = 4000;

export const reviewStateSchema = z.enum([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
]);

export const reviewVisibilitySchema = z.enum(["INTERNAL", "APPLICANT"]);

export const submitReviewSchema = z.object({
  projectId: z.string().min(1),
  appId: z.string().min(1),
  state: reviewStateSchema,
  body: z.string().max(NOTE_BODY_MAX).optional().default(""),
  // Only honored when state="COMMENTED"; otherwise derived from state.
  visibility: reviewVisibilitySchema.optional(),
  // Draft per-field comments to attach. Authorship + ownership re-checked
  // server-side before linking.
  draftCommentIds: z.array(z.string().min(1)).max(40).default([]),
});

export const fieldCommentSchema = z.object({
  projectId: z.string().min(1),
  appId: z.string().min(1),
  fieldId: fieldIdSchema,
  body: z.string().min(1).max(NOTE_BODY_MAX),
});

export const editNoteSchema = z.object({
  projectId: z.string().min(1),
  appId: z.string().min(1),
  noteId: z.string().min(1),
  body: z.string().min(1).max(NOTE_BODY_MAX),
});

export const deleteNoteSchema = z.object({
  projectId: z.string().min(1),
  appId: z.string().min(1),
  noteId: z.string().min(1),
});

export const replyToCommentSchema = z.object({
  projectId: z.string().min(1),
  appId: z.string().min(1),
  parentId: z.string().min(1),
  body: z.string().min(1).max(NOTE_BODY_MAX),
});

export const dismissReviewSchema = z.object({
  projectId: z.string().min(1),
  appId: z.string().min(1),
  reviewId: z.string().min(1),
});

export function visibilityForReviewState(
  state: z.infer<typeof reviewStateSchema>,
  chosen: z.infer<typeof reviewVisibilitySchema> | undefined,
): "INTERNAL" | "APPLICANT" {
  if (state === "APPROVED") return "INTERNAL";
  if (state === "CHANGES_REQUESTED") return "APPLICANT";
  return chosen ?? "INTERNAL";
}

export const DEFAULT_FORM_SCHEMA: FormSchema = [
  {
    id: "motivation",
    type: "textarea",
    label: "Why do you want to contribute to this project?",
    required: true,
    placeholder: "A few sentences about your interest.",
    maxLength: 2000,
  },
  {
    id: "experience",
    type: "textarea",
    label: "What's your relevant experience?",
    required: true,
    maxLength: 2000,
  },
  {
    id: "first_pr",
    type: "text",
    label: "What kind of PR are you planning to open first?",
    required: false,
    maxLength: 200,
  },
];
