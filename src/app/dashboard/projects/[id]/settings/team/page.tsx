import Image from "next/image";
import { requireProjectRole } from "@/lib/authz";
import { listMembers } from "@/lib/teams";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { parsePageParams, type SearchParamRecord } from "@/lib/pagination";
import { inviteMember, removeMemberAction, changeRoleAction } from "./actions";
import { RoleSelect } from "./role-select";

export default async function ProjectTeam({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParamRecord>;
}) {
  const { id } = await params;
  const { session, role: viewerRole } = await requireProjectRole(id, "ADMIN");
  const { q } = parsePageParams(await searchParams);
  const allMembers = await listMembers(id);
  const needle = q.toLowerCase();
  const members = needle
    ? allMembers.filter(
        (m) =>
          (m.user.ghLogin ?? "").toLowerCase().includes(needle) ||
          (m.user.name ?? "").toLowerCase().includes(needle)
      )
    : allMembers;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invite member</CardTitle>
          <CardDescription>
            The user must have signed in with GitHub at least once for them to
            be invitable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={inviteMember} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <input type="hidden" name="projectId" value={id} />
            <div className="flex-1 space-y-2">
              <Label htmlFor="ghLogin">GitHub login</Label>
              <Input id="ghLogin" name="ghLogin" placeholder="octocat" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <select
                id="role"
                name="role"
                defaultValue="REVIEWER"
                className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              >
                <option value="REVIEWER">Reviewer</option>
                <option value="ADMIN">Admin</option>
                {viewerRole === "OWNER" && <option value="OWNER">Owner (transfer)</option>}
              </select>
            </div>
            <SubmitButton>Invite</SubmitButton>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="border-b border-border px-6 py-3">
            <SearchInput
              pathname={`/dashboard/projects/${id}/settings/team`}
              q={q}
              placeholder="Search login or name"
            />
          </div>
          {members.length === 0 ? (
            <div className="px-6 py-6 text-sm text-muted-foreground">
              {q ? "No members match your search." : "No members yet."}
            </div>
          ) : (
          <ul className="divide-y divide-border">
            {members.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 px-6 py-3"
              >
                <div className="flex items-center gap-3">
                  {m.user.image && (
                    <Image
                      src={m.user.image}
                      alt={m.user.ghLogin ?? ""}
                      width={28}
                      height={28}
                      className="rounded-full"
                    />
                  )}
                  <div>
                    <div className="text-sm font-medium">
                      {m.user.ghLogin ?? "(no login)"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {m.user.name}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{m.role}</Badge>
                  {m.role !== "OWNER" && m.userId !== session.user.id && (
                    <>
                      <form action={changeRoleAction}>
                        <input type="hidden" name="projectId" value={id} />
                        <input type="hidden" name="memberId" value={m.id} />
                        <RoleSelect defaultValue={m.role} />
                      </form>
                      <form action={removeMemberAction}>
                        <input type="hidden" name="projectId" value={id} />
                        <input type="hidden" name="memberId" value={m.id} />
                        <SubmitButton
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:bg-destructive/10"
                        >
                          Remove
                        </SubmitButton>
                      </form>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
