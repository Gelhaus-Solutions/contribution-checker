import type { FormSchema } from "@/lib/applications/schema";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export function FormRenderer({
  fields,
  values,
  disabled,
}: {
  fields: FormSchema;
  values?: Record<string, string | boolean | undefined>;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-5">
      {fields.map((field) => {
        const inputId = `f_${field.id}`;
        const required = field.required;
        const value = values?.[field.id];

        return (
          <div key={field.id} className="space-y-2">
            <Label htmlFor={inputId}>
              {field.label}
              {required && <span className="ml-1 text-destructive">*</span>}
            </Label>
            {field.type === "text" || field.type === "url" ? (
              <Input
                id={inputId}
                name={field.id}
                type={field.type === "url" ? "url" : "text"}
                placeholder={field.placeholder}
                maxLength={field.maxLength}
                required={required}
                defaultValue={typeof value === "string" ? value : ""}
                disabled={disabled}
              />
            ) : field.type === "textarea" ? (
              <Textarea
                id={inputId}
                name={field.id}
                placeholder={field.placeholder}
                maxLength={field.maxLength}
                required={required}
                rows={4}
                defaultValue={typeof value === "string" ? value : ""}
                disabled={disabled}
              />
            ) : field.type === "select" ? (
              <select
                id={inputId}
                name={field.id}
                required={required}
                defaultValue={typeof value === "string" ? value : ""}
                disabled={disabled}
                className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">— select —</option>
                {field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <label className="flex items-center gap-2 text-sm">
                <input
                  id={inputId}
                  name={field.id}
                  type="checkbox"
                  required={required}
                  defaultChecked={value === true}
                  disabled={disabled}
                  className="h-4 w-4 rounded border-border"
                />
                <span>{field.helpText ?? "I confirm."}</span>
              </label>
            )}
            {field.helpText && field.type !== "checkbox" && (
              <p className="text-xs text-muted-foreground">{field.helpText}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
