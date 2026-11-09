import type { Metadata } from "next";
import { LocationsView } from "./locations-view";

// /admin/locations (P2.6): ADMIN only (nav.ts, and requireRole in every handler).

export const metadata: Metadata = { title: "Locations" };

export default function LocationsPage() {
  return <LocationsView />;
}
