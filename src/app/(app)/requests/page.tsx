import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { RequestList } from "./request-list";

// /requests (P2.2): ADMIN, COORDINATOR, FIELD_OFFICER (nav.ts; the proxy sends
// other roles to /dashboard). Only Field Officers and Coordinators create
// requests; the API enforces the same roles.

export const metadata: Metadata = { title: "Requests" };

export default async function RequestsPage() {
  // getSession() in a page is HANDOFF 4.5's one exception; the layout already signed the user in.
  const session = await getSession();
  const canCreate = session?.role === "FIELD_OFFICER" || session?.role === "COORDINATOR";
  return <RequestList canCreate={canCreate} />;
}
