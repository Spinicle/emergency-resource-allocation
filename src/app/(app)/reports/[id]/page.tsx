import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { idParam } from "@/lib/validators/common";
import { ReportDetailView } from "./report-detail";

// /reports/[id] (P2.3): same roles as /reports (the proxy covers pages under a
// nav entry). id is the observation_id; data comes from GET /api/reports/[id].

export const metadata: Metadata = { title: "Field report" };

export default async function ReportPage({ params }: PageProps<"/reports/[id]">) {
  const parsed = idParam.safeParse((await params).id);
  if (!parsed.success) notFound();
  return <ReportDetailView id={parsed.data} />;
}
