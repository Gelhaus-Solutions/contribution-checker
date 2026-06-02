"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { PROJECT_LEAF_PERMISSIONS } from "@/lib/auth/constants";
import { requireProjectPermission, requireProjectRole } from "@/lib/authz";
import {
  inviteMemberByGhLogin,
  changeMemberRole,
  removeMember,
  setMemberExtraPermission,
} from "@/lib/teams";

const roleEnum = z.enum(["OWNER", "ADMIN", "REVIEWER"]);

const inviteSchema = z.object({
  projectId: z.string().min(1),
  ghLogin: z.string().min(1).max(80),
  role: roleEnum,
});

export async function inviteMember(formData: FormData) {
  const parsed = inviteSchema.parse({
    projectId: formData.get("projectId"),
    ghLogin: String(formData.get("ghLogin") ?? "").trim(),
    role: formData.get("role"),
  });
  // Owners can invite anyone (including transferring OWNER); admins cannot grant OWNER.
  const required = parsed.role === "OWNER" ? "OWNER" : "ADMIN";
  const { session } = await requireProjectRole(parsed.projectId, required);

  await inviteMemberByGhLogin({
    projectId: parsed.projectId,
    actorId: session.user.id,
    ghLogin: parsed.ghLogin,
    role: parsed.role,
  });

  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings/team`);
}

const changeRoleSchema = z.object({
  projectId: z.string().min(1),
  memberId: z.string().min(1),
  role: roleEnum,
});

export async function changeRoleAction(formData: FormData) {
  const parsed = changeRoleSchema.parse({
    projectId: formData.get("projectId"),
    memberId: formData.get("memberId"),
    role: formData.get("role"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");
  await changeMemberRole({
    projectId: parsed.projectId,
    actorId: session.user.id,
    memberId: parsed.memberId,
    role: parsed.role,
  });
  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings/team`);
}

const removeSchema = z.object({
  projectId: z.string().min(1),
  memberId: z.string().min(1),
});

export async function removeMemberAction(formData: FormData) {
  const parsed = removeSchema.parse({
    projectId: formData.get("projectId"),
    memberId: formData.get("memberId"),
  });
  const { session } = await requireProjectRole(parsed.projectId, "ADMIN");
  await removeMember({
    projectId: parsed.projectId,
    actorId: session.user.id,
    memberId: parsed.memberId,
  });
  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings/team`);
}

const setPermissionSchema = z.object({
  projectId: z.string().min(1),
  memberId: z.string().min(1),
  permission: z.enum(PROJECT_LEAF_PERMISSIONS),
  granted: z.boolean(),
});

/** Grant/revoke a single explicit extra-access leaf permission for a member. */
export async function setMemberPermissionAction(input: {
  projectId: string;
  memberId: string;
  permission: string;
  granted: boolean;
}) {
  const parsed = setPermissionSchema.parse(input);
  const { session } = await requireProjectPermission(
    parsed.projectId,
    "project_members_manage",
  );
  await setMemberExtraPermission({
    projectId: parsed.projectId,
    actorId: session.user.id,
    memberId: parsed.memberId,
    permission: parsed.permission,
    granted: parsed.granted,
  });
  revalidatePath(`/dashboard/projects/${parsed.projectId}/settings/team`);
}
