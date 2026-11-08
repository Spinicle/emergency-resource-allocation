import type { Metadata } from "next";
import { NewReportForm } from "./new-report-form";

// /reports/new (P2.3): same roles as /reports and POST /api/observations.

export const metadata: Metadata = { title: "File a field report" };

export default function NewReportPage() {
  return <NewReportForm />;
}
