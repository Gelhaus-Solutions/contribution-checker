"use client";

export function RoleSelect({ defaultValue }: { defaultValue: string }) {
  return (
    <select
      name="role"
      defaultValue={defaultValue}
      className="h-7 rounded-md border border-border bg-background px-2 text-xs"
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
    >
      <option value="REVIEWER">Reviewer</option>
      <option value="ADMIN">Admin</option>
    </select>
  );
}
