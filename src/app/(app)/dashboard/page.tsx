import type { Metadata } from "next";
import { DashboardView } from "./dashboard-view";

// /dashboard (P2.4): every role's landing page. The API scopes what each role sees.

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return <DashboardView />;
}
