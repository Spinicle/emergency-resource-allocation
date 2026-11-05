import type { Metadata } from "next";
import { Suspense } from "react";
import { AllocateView } from "./allocate-view";

// /allocate (P1.8): ADMIN and COORDINATOR (nav.ts; the proxy sends other roles
// to /dashboard, and every /api/allocations handler checks the role too).

export const metadata: Metadata = { title: "Allocate" };

export default function AllocatePage() {
  // AllocateView reads ?item= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense>
      <AllocateView />
    </Suspense>
  );
}
