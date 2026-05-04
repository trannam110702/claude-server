import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { UsersTable } from "./UsersTable";

export default async function UsersPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!session.user.isAdmin) redirect("/dashboard");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Everyone who has signed into this dashboard. Toggle Admin to grant or
          revoke dashboard admin rights.
        </p>
      </div>
      <UsersTable />
    </div>
  );
}
