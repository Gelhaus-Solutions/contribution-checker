import Image from "next/image";
import { prisma } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/authz";
import { SiteHeader } from "@/components/site-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  grantCreatorByGhLogin,
  revokeCreator,
  toggleSuperAdmin,
} from "./actions";

export default async function AllowlistPage() {
  await requireSuperAdmin();

  const users = await prisma.user.findMany({
    where: {
      OR: [{ canCreateProj: true }, { isSuperAdmin: true }],
    },
    select: {
      id: true,
      ghLogin: true,
      name: true,
      image: true,
      canCreateProj: true,
      isSuperAdmin: true,
    },
    orderBy: { ghLogin: "asc" },
  });

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
        <div>
          <h1 className="text-2xl font-semibold">Allowlist</h1>
          <p className="text-sm text-muted-foreground">
            Users with project-creation rights or super-admin role.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Grant project-creation</CardTitle>
            <CardDescription>
              The user must have signed in once before they can be granted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              action={grantCreatorByGhLogin}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex-1 space-y-2">
                <Label htmlFor="ghLogin">GitHub login</Label>
                <Input id="ghLogin" name="ghLogin" placeholder="octocat" required />
              </div>
              <Button type="submit">Grant</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Allowlisted users</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {users.length === 0 ? (
              <div className="px-6 pb-6 text-sm text-muted-foreground">
                None yet. Grant access above.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {users.map((u) => (
                  <li
                    key={u.id}
                    className="flex items-center justify-between gap-3 px-6 py-3"
                  >
                    <div className="flex items-center gap-3">
                      {u.image && (
                        <Image
                          src={u.image}
                          alt={u.ghLogin ?? ""}
                          width={28}
                          height={28}
                          className="rounded-full"
                        />
                      )}
                      <div>
                        <div className="text-sm font-medium">{u.ghLogin}</div>
                        <div className="text-xs text-muted-foreground">{u.name}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {u.isSuperAdmin && <Badge variant="warning">super-admin</Badge>}
                      {u.canCreateProj && <Badge variant="outline">creator</Badge>}
                      <form action={toggleSuperAdmin}>
                        <input type="hidden" name="userId" value={u.id} />
                        <Button type="submit" size="sm" variant="outline">
                          {u.isSuperAdmin ? "Revoke super" : "Make super"}
                        </Button>
                      </form>
                      {u.canCreateProj && !u.isSuperAdmin && (
                        <form action={revokeCreator}>
                          <input type="hidden" name="userId" value={u.id} />
                          <Button
                            type="submit"
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:bg-destructive/10"
                          >
                            Revoke
                          </Button>
                        </form>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
