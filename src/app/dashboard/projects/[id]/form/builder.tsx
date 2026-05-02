"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FormRenderer } from "@/components/form-renderer";
import type { Field, FormSchema } from "@/lib/applications/schema";

type FieldType = Field["type"];

const TYPE_LABELS: Record<FieldType, string> = {
  text: "Short text",
  textarea: "Long text",
  url: "URL",
  select: "Select",
  checkbox: "Checkbox",
};

function makeField(type: FieldType, idx: number): Field {
  const base = {
    id: `field_${idx}`,
    label: "New field",
    required: false as const,
    helpText: undefined,
  };
  if (type === "select") {
    return {
      ...base,
      type,
      options: [{ value: "yes", label: "Yes" }],
    };
  }
  if (type === "checkbox") {
    return { ...base, type };
  }
  return { ...base, type };
}

export function FormBuilder({
  projectId,
  initial,
  action,
}: {
  projectId: string;
  initial: FormSchema;
  action: (formData: FormData) => Promise<void>;
}) {
  const [fields, setFields] = useState<FormSchema>(initial);
  const [isPending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const updateField = (i: number, patch: Partial<Field>) => {
    setFields((prev) =>
      prev.map((f, idx) => (idx === i ? ({ ...f, ...patch } as Field) : f))
    );
  };

  const move = (i: number, dir: -1 | 1) => {
    setFields((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const remove = (i: number) =>
    setFields((prev) => prev.filter((_, idx) => idx !== i));

  const add = (type: FieldType) =>
    setFields((prev) => [...prev, makeField(type, prev.length)]);

  const onSave = () => {
    const fd = new FormData();
    fd.set("projectId", projectId);
    fd.set("schema", JSON.stringify(fields));
    startTransition(async () => {
      await action(fd);
      setSavedAt(new Date().toLocaleTimeString());
    });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Fields</h3>
          <div className="flex flex-wrap gap-1">
            {(Object.keys(TYPE_LABELS) as FieldType[]).map((t) => (
              <Button
                key={t}
                size="sm"
                variant="outline"
                type="button"
                onClick={() => add(t)}
              >
                + {TYPE_LABELS[t]}
              </Button>
            ))}
          </div>
        </div>

        {fields.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No fields yet — add one above.
          </p>
        )}

        {fields.map((f, i) => (
          <Card key={i}>
            <CardHeader className="flex-row items-center justify-between gap-2 pb-3">
              <Badge variant="outline">{TYPE_LABELS[f.type]}</Badge>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => move(i, 1)}
                  disabled={i === fields.length - 1}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => remove(i)}
                >
                  Delete
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">ID</Label>
                  <Input
                    value={f.id}
                    onChange={(e) => updateField(i, { id: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Label</Label>
                  <Input
                    value={f.label}
                    onChange={(e) => updateField(i, { label: e.target.value })}
                  />
                </div>
              </div>

              {(f.type === "text" || f.type === "textarea") && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Placeholder</Label>
                    <Input
                      value={f.placeholder ?? ""}
                      onChange={(e) =>
                        updateField(i, { placeholder: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Max length</Label>
                    <Input
                      type="number"
                      value={f.maxLength ?? ""}
                      onChange={(e) =>
                        updateField(i, {
                          maxLength: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                    />
                  </div>
                </div>
              )}

              {f.type === "select" && (
                <div className="space-y-2">
                  <Label className="text-xs">Options (one per line, value|label)</Label>
                  <Textarea
                    rows={3}
                    value={f.options
                      .map((o) => `${o.value}|${o.label}`)
                      .join("\n")}
                    onChange={(e) =>
                      updateField(i, {
                        options: e.target.value
                          .split("\n")
                          .map((line) => line.trim())
                          .filter(Boolean)
                          .map((line) => {
                            const [value, ...rest] = line.split("|");
                            return {
                              value: value.trim(),
                              label: (rest.join("|").trim() || value).trim(),
                            };
                          }),
                      })
                    }
                  />
                </div>
              )}

              <div className="space-y-1">
                <Label className="text-xs">Help text</Label>
                <Input
                  value={f.helpText ?? ""}
                  onChange={(e) =>
                    updateField(i, { helpText: e.target.value || undefined })
                  }
                />
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => updateField(i, { required: e.target.checked })}
                />
                Required
              </label>
            </CardContent>
          </Card>
        ))}

        <div className="flex items-center gap-3 pt-2">
          <Button type="button" onClick={onSave} disabled={isPending}>
            {isPending ? "Saving…" : "Save form"}
          </Button>
          {savedAt && (
            <span className="text-xs text-muted-foreground">
              Saved at {savedAt}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Preview</h3>
        <Card>
          <CardContent className="py-6">
            {fields.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                The form is empty.
              </p>
            ) : (
              <FormRenderer fields={fields} disabled />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
