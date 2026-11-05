import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { idParam } from "@/lib/validators/common";
import { EmergencyDetailView } from "./emergency-detail";

// /emergencies/[id] (P2.1): same roles as /emergencies (the proxy covers pages
// under a nav entry). Data comes from GET /api/emergencies/[id].

export const metadata: Metadata = { title: "Emergency" };

export default async function EmergencyPage({ params }: PageProps<"/emergencies/[id]">) {
  const parsed = idParam.safeParse((await params).id);
  if (!parsed.success) notFound();

  // getSession() in a page is HANDOFF 4.5's one exception; the layout already signed the user in.
  const session = await getSession();
  const canEdit = session?.role === "ADMIN" || session?.role === "COORDINATOR";
  return <EmergencyDetailView id={parsed.data} canEdit={canEdit} />;
}
