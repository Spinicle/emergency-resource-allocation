import type { Metadata } from "next";
import { ResourcesView } from "./resources-view";

// /admin/resources (P2.6): ADMIN only (nav.ts, and requireRole in every handler).

export const metadata: Metadata = { title: "Resources" };

export default function ResourcesPage() {
  return <ResourcesView />;
}
