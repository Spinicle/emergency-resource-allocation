import type { CSSProperties, ReactNode } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Session } from "@/lib/auth";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";

/** Sidebar + header + page. Everything it shows comes from the session. */
export function AppShell({
  session,
  sidebarOpen,
  children,
}: {
  session: Session;
  sidebarOpen: boolean;
  children: ReactNode;
}) {
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={sidebarOpen} style={{ "--sidebar-width": "15rem" } as CSSProperties}>
        <AppSidebar role={session.role} />
        <SidebarInset className="min-w-0">
          <AppHeader session={session} />
          {/* SidebarInset is already the page's <main>. */}
          <div className="flex-1 p-4 md:p-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
