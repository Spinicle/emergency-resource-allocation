import type { Metadata } from "next";
import { CentersView } from "./centers-view";

// /admin/centers (P2.6): ADMIN only (nav.ts, and requireRole in every handler).

export const metadata: Metadata = { title: "Centers" };

export default function CentersPage() {
  return <CentersView />;
}
