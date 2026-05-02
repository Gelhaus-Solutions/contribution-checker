import { describe, expect, it } from "vitest";
import {
  buildAnswersSchema,
  formSchema,
  parseFormSchema,
} from "@/lib/applications/schema";

describe("formSchema", () => {
  it("accepts a valid mixed schema", () => {
    const fields = [
      { id: "a", type: "text", label: "A", required: true },
      { id: "b", type: "textarea", label: "B", required: false, maxLength: 500 },
      { id: "c", type: "url", label: "C", required: false },
      {
        id: "d",
        type: "select",
        label: "D",
        required: true,
        options: [{ value: "x", label: "X" }],
      },
      { id: "e", type: "checkbox", label: "E", required: true },
    ];
    expect(() => formSchema.parse(fields)).not.toThrow();
  });

  it("rejects bad field type", () => {
    const fields = [{ id: "a", type: "weird", label: "A", required: false }];
    expect(() => formSchema.parse(fields)).toThrow();
  });
});

describe("parseFormSchema", () => {
  it("returns [] for invalid JSON", () => {
    expect(parseFormSchema("not json")).toEqual([]);
  });
  it("returns [] for invalid schema", () => {
    expect(parseFormSchema(JSON.stringify({ nope: 1 }))).toEqual([]);
  });
});

describe("buildAnswersSchema", () => {
  it("requires populated values for required text", () => {
    const fields = formSchema.parse([
      { id: "a", type: "text", label: "A", required: true },
    ]);
    const s = buildAnswersSchema(fields);
    expect(() => s.parse({ a: "" })).toThrow();
    expect(() => s.parse({ a: "ok" })).not.toThrow();
  });

  it("requires checkbox === true when required", () => {
    const fields = formSchema.parse([
      { id: "tos", type: "checkbox", label: "Agree", required: true },
    ]);
    const s = buildAnswersSchema(fields);
    expect(() => s.parse({ tos: false })).toThrow();
    expect(() => s.parse({ tos: true })).not.toThrow();
  });

  it("validates select against allowed options", () => {
    const fields = formSchema.parse([
      {
        id: "size",
        type: "select",
        label: "Size",
        required: true,
        options: [
          { value: "s", label: "S" },
          { value: "m", label: "M" },
        ],
      },
    ]);
    const s = buildAnswersSchema(fields);
    expect(() => s.parse({ size: "xl" })).toThrow();
    expect(() => s.parse({ size: "m" })).not.toThrow();
  });
});
