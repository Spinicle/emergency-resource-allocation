import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell/app-shell";
import { getSession } from "@/lib/auth";

// The signed-in shell around every page in (app) (docs/HANDOFF.md 4.7).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Checked against the database, so a deactivated user or a changed role or
  // center is signed out on the next page load, even with a valid token.
  const session = await getSession();
  if (!session) redirect("/login");

  // The sidebar remembers whether it was collapsed (shadcn's sidebar_state cookie).
  const sidebarOpen = (await cookies()).get("sidebar_state")?.value !== "false";

  return (
    <AppShell session={session} sidebarOpen={sidebarOpen}>
      {children}
    </AppShell>
  );
}
