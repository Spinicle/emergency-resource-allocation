import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { UsersView } from "./users-view";

// /admin/users (P2.6): ADMIN only (nav.ts, and requireRole in every handler).

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  // getSession() in a page is HANDOFF 4.5's one exception; the layout already signed the user in.
  const session = await getSession();
  return <UsersView currentUserId={session?.userId ?? null} />;
}
