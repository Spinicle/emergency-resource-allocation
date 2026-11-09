import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { InventoryView } from "./inventory-view";

// /inventory (P2.6): ADMIN (any center, with a picker) and CENTER_MANAGER (their
// own only). nav.ts covers the page; the stock API enforces the scope.

export const metadata: Metadata = { title: "Inventory" };

export default async function InventoryPage() {
  // getSession() in a page is HANDOFF 4.5's one exception; the layout already signed the user in.
  const session = await getSession();
  if (!session) return null;
  return <InventoryView isAdmin={session.role === "ADMIN"} ownCenterId={session.centerId} />;
}
