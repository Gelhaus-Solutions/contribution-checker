"use client";

import { Select } from "@/components/ui/select";

export function RoleSelect({ defaultValue }: { defaultValue: string }) {
  return (
    <Select
      name="role"
      fieldSize="sm"
      defaultValue={defaultValue}
      // Native element on purpose: Radix has no `form` association, so this
      // submit-on-change would have nothing to submit.
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
    >
      <option value="REVIEWER">Reviewer</option>
      <option value="ADMIN">Admin</option>
    </Select>
  );
}
