import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { idParam } from "@/lib/validators/common";
import { RequestDetailView } from "./request-detail";

// /requests/[id] (P2.2): same roles as /requests (the proxy covers pages under
// a nav entry). Data comes from GET /api/requests/[id].

export const metadata: Metadata = { title: "Request" };

export default async function RequestPage({ params }: PageProps<"/requests/[id]">) {
  const parsed = idParam.safeParse((await params).id);
  if (!parsed.success) notFound();

  // getSession() in a page is HANDOFF 4.5's one exception; the layout already signed the user in.
  const session = await getSession();
  // /allocate is ADMIN and COORDINATOR only: the proxy would bounce anyone else off the link.
  const canAllocate = session?.role === "ADMIN" || session?.role === "COORDINATOR";
  return <RequestDetailView id={parsed.data} canAllocate={canAllocate} />;
}
