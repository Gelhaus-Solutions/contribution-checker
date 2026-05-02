import { z } from "zod";

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

export const textFieldSchema = baseFieldSchema.extend({
  type: z.enum(["text", "textarea", "url"]),
  placeholder: z.string().max(120).optional(),
  maxLength: z.number().int().positive().max(10000).optional(),
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
      case "url":
        s = z.string().url();
        if (!f.required) s = s.optional().or(z.literal(""));
        break;
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
