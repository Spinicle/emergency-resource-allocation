"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import type { ErasMapProps } from "./map-types";

export { centerStatusColor, type ErasMapProps, type MapPoint, severityColor } from "./map-types";

// The map every page uses. ssr: false is only allowed in a Client Component.

const MapView = dynamic(() => import("./map-view"), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
});

/** isolate keeps Leaflet's high z-indexes from covering dropdowns and dialogs. */
export function ErasMap(props: ErasMapProps) {
  return (
    <div className="isolate">
      <MapView {...props} />
    </div>
  );
}
