import type { FormSchema } from "@/lib/applications/schema";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export type FormValue = string | boolean | undefined;

export function FormRenderer({
  fields,
  values,
  onChange,
  disabled,
  namePrefix = "",
}: {
  fields: FormSchema;
  values?: Record<string, FormValue>;
  onChange?: (id: string, value: string | boolean) => void;
  disabled?: boolean;
  // Prefix applied to the input `name` (and id) so a field set can be embedded
  // alongside another form without key collisions. The server strips it back
  // off when collecting answers. Defaults to "" (no prefix).
  namePrefix?: string;
}) {
  const controlled = onChange != null;
  return (
    <div className="space-y-5">
      {fields.map((field) => {
        const inputName = `${namePrefix}${field.id}`;
        const inputId = `f_${inputName}`;
        const required = field.required;
        const value = values?.[field.id];
        const stringValue = typeof value === "string" ? value : "";
        const boolValue = value === true;

        return (
          <div key={field.id} className="space-y-2">
            <Label htmlFor={inputId}>
              {field.label}
              {required && <span className="ml-1 text-destructive">*</span>}
            </Label>
            {field.type === "text" || field.type === "url" ? (
              <Input
                id={inputId}
                name={inputName}
                type={field.type === "url" ? "url" : "text"}
                placeholder={field.placeholder}
                maxLength={field.maxLength}
                required={required}
                disabled={disabled}
                {...(controlled
                  ? {
                      value: stringValue,
                      onChange: (e) => onChange(field.id, e.target.value),
                    }
                  : { defaultValue: stringValue })}
              />
            ) : field.type === "textarea" ? (
              <Textarea
                id={inputId}
                name={inputName}
                placeholder={field.placeholder}
                maxLength={field.maxLength}
                required={required}
                rows={4}
                disabled={disabled}
                {...(controlled
                  ? {
                      value: stringValue,
                      onChange: (e) => onChange(field.id, e.target.value),
                    }
                  : { defaultValue: stringValue })}
              />
            ) : field.type === "select" ? (
              <select
                id={inputId}
                name={inputName}
                required={required}
                disabled={disabled}
                className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                {...(controlled
                  ? {
                      value: stringValue,
                      onChange: (e) => onChange(field.id, e.target.value),
                    }
                  : { defaultValue: stringValue })}
              >
                <option value="">Select...</option>
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
                  name={inputName}
                  type="checkbox"
                  required={required}
                  disabled={disabled}
                  className="h-4 w-4 rounded border-border"
                  {...(controlled
                    ? {
                        checked: boolValue,
                        onChange: (e) => onChange(field.id, e.target.checked),
                      }
                    : { defaultChecked: boolValue })}
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
