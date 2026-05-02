import { z } from "zod";

export const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9](-?[a-z0-9])+$/, "lowercase letters, numbers, single dashes only");

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
