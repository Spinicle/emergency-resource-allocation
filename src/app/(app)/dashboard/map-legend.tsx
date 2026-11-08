import { centerStatusColor, severityColor } from "@/components/map";
import { CENTER_STATUSES, SEVERITIES } from "@/lib/enums";
import { humanize } from "@/app/(app)/emergencies/format";

// What the dashboard map's shapes and colours mean: circles are impacts by
// latest severity, squares are centers by status.

function Key({ color, square, label }: { color: string; square?: boolean; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden className={`size-3 ${square ? "rounded-[2px]" : "rounded-full"}`} style={{ background: color }} />
      {label}
    </li>
  );
}

export function MapLegend() {
  return (
    <div className="mt-3 flex flex-col gap-1 text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-x-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">Impacts</span>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {SEVERITIES.map((s) => (
            <Key key={s} color={severityColor(s)} label={humanize(s)} />
          ))}
          <Key color={severityColor(null)} label="No observation" />
        </ul>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">Centers</span>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {CENTER_STATUSES.map((s) => (
            <Key key={s} square color={centerStatusColor(s)} label={humanize(s)} />
          ))}
        </ul>
      </div>
    </div>
  );
}
