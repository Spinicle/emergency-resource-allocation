"use client";

import { ChevronsUpDown, LogOut } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { NAV, ROLE_LABELS, isActivePath } from "@/config/nav";
import type { Session } from "@/lib/auth";
import { api } from "@/lib/client";

export function AppHeader({ session }: { session: Session }) {
  const pathname = usePathname();
  const router = useRouter();
  const section = NAV.flatMap((g) => g.items).find((i) => isActivePath(pathname, i.href));

  async function signOut() {
    // P1.6: POST /api/auth/logout clears the session cookie. Until it exists,
    // the API catch-all answers 404 and this shows that error.
    try {
      await api("/api/auth/logout", { method: "POST" });
      router.replace("/login");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign-out failed");
    }
  }

  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
      <h1 className="truncate font-medium">{section?.label ?? "ERAS"}</h1>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="ml-auto h-8 gap-2 px-2">
            <span className="hidden max-w-40 truncate sm:inline">{session.name}</span>
            <Badge variant="secondary">{ROLE_LABELS[session.role]}</Badge>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate">{session.name}</span>
            <span className="text-xs font-normal text-muted-foreground">{ROLE_LABELS[session.role]}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={signOut}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
