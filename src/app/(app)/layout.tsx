import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell/app-shell";
import { getStandInSession } from "./stand-in-session";

// The signed-in shell around every page in (app) (docs/HANDOFF.md 4.7).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // P1.6: replace with
  //   const session = await getSession();
  //   if (!session) redirect("/login");
  const session = await getStandInSession();

  // The sidebar remembers whether it was collapsed (shadcn's sidebar_state cookie).
  const sidebarOpen = (await cookies()).get("sidebar_state")?.value !== "false";

  return (
    <AppShell session={session} sidebarOpen={sidebarOpen}>
      {children}
    </AppShell>
  );
}
