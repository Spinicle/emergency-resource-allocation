import { centerStatusColor, MapKey, severityMarker } from "@/components/map";
import { CENTER_STATUSES, SEVERITIES } from "@/lib/enums";
import { humanize } from "@/app/(app)/emergencies/format";

// What the dashboard map's shapes and colours mean: circles are impacts by
// latest severity (a hollow ring when none is observed yet), squares are
// centers by status. Swatches come from the same functions as the markers.

export function MapLegend() {
  return (
    <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:gap-x-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-muted-foreground">Impacts</span>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {SEVERITIES.map((s) => (
            <MapKey key={s} {...severityMarker(s)} label={humanize(s)} />
          ))}
          <MapKey {...severityMarker(null)} label="No observation" />
        </ul>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-muted-foreground">Centers</span>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {CENTER_STATUSES.map((s) => (
            <MapKey key={s} shape="square" color={centerStatusColor(s)} label={humanize(s)} />
          ))}
        </ul>
      </div>
    </div>
  );
}
