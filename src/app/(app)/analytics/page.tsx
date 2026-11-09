import type { Metadata } from "next";
import { AnalyticsView } from "./analytics-view";

// /analytics (P2.5): ADMIN and COORDINATOR (nav.ts; the proxy sends other roles
// to /dashboard, and every /api/analytics handler checks the same roles).

export const metadata: Metadata = { title: "Analytics" };

export default function AnalyticsPage() {
  return <AnalyticsView />;
}
