import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { EmergencyList } from "./emergency-list";

// /emergencies (P2.1): ADMIN, COORDINATOR, FIELD_OFFICER (nav.ts; the proxy
// sends other roles to /dashboard). Only ADMIN and COORDINATOR see the write
// controls; the API enforces the same roles.

export const metadata: Metadata = { title: "Emergencies" };

export default async function EmergenciesPage() {
  // getSession() in a page is HANDOFF 4.5's one exception; the layout already signed the user in.
  const session = await getSession();
  const canEdit = session?.role === "ADMIN" || session?.role === "COORDINATOR";
  return <EmergencyList canEdit={canEdit} />;
}
