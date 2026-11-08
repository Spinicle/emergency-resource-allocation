import type { Metadata } from "next";
import { Suspense } from "react";
import { ReportList } from "./report-list";

// /reports (P2.3): ADMIN, COORDINATOR, FIELD_OFFICER (nav.ts; the proxy sends
// other roles to /dashboard, and the API checks the same roles).

export const metadata: Metadata = { title: "Field reports" };

export default function ReportsPage() {
  // ReportList keeps its filters in the URL with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense>
      <ReportList />
    </Suspense>
  );
}
