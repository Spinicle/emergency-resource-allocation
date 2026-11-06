"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatIst } from "@/app/(app)/allocate/format";
import { InlineError } from "@/app/(app)/allocate/bits";
import { DataTable, dataTableColumns, SortableHeader } from "@/components/data-table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useApi } from "@/lib/client";
import type { EmergencyRow } from "@/lib/emergency-types";
import { EMERGENCY_STATUSES, EMERGENCY_TYPES } from "@/lib/enums";
import { MAX_SEARCH_LENGTH } from "@/lib/validators/fields";
import { PhaseBadge } from "./badges";
import { EmergencyDialog } from "./emergency-dialog";
import { humanize, withQuery } from "./format";

// /emergencies: status, type and full-text search run in MySQL through the
// query string; DataTable sorts and pages what comes back.

/** Radix Select items can't have an empty value, so "all" is its own value. */
const ALL = "ALL";

const col = dataTableColumns<EmergencyRow>();
const columns = col.columns([
  col.accessor("name", {
    header: ({ column }) => <SortableHeader column={column} title="Name" />,
    cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
  }),
  col.accessor("type", {
    header: ({ column }) => <SortableHeader column={column} title="Type" />,
    cell: ({ getValue }) => humanize(getValue()),
  }),
  col.accessor("status", {
    header: ({ column }) => <SortableHeader column={column} title="Status" />,
    cell: ({ getValue }) => <PhaseBadge value={getValue()} />,
  }),
  col.accessor("start_time", {
    header: ({ column }) => <SortableHeader column={column} title="Started" />,
    cell: ({ getValue }) => formatIst(getValue()),
  }),
  col.accessor("end_time", { header: "Ended", cell: ({ getValue }) => formatIst(getValue()) }),
  col.accessor("impact_count", { header: ({ column }) => <SortableHeader column={column} title="Impacts" /> }),
  col.accessor("request_count", { header: ({ column }) => <SortableHeader column={column} title="Requests" /> }),
]);

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={`Filter by ${label}`} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label === "status" ? "statuses" : "types"}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {humanize(o)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function EmergencyList({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState(ALL);
  const [type, setType] = useState(ALL);
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim());

  const list = useApi<EmergencyRow[]>(
    withQuery("/api/emergencies", {
      status: status === ALL ? undefined : status,
      type: type === ALL ? undefined : type,
      q,
    }),
  );

  // A new filter is a new SWR key, so list.data is undefined until it answers.
  // Showing the last rows meanwhile keeps the table mounted, with its sort.
  const [lastRows, setLastRows] = useState<EmergencyRow[]>();
  if (list.data && list.data !== lastRows) setLastRows(list.data);
  const rows = list.data ?? lastRows;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name and description…"
          aria-label="Search emergencies"
          maxLength={MAX_SEARCH_LENGTH}
          className="w-full sm:w-72"
        />
        <FilterSelect label="status" value={status} onChange={setStatus} options={EMERGENCY_STATUSES} />
        <FilterSelect label="type" value={type} onChange={setType} options={EMERGENCY_TYPES} />
        {canEdit && (
          <div className="ml-auto">
            <EmergencyDialog />
          </div>
        )}
      </div>

      {/* A failed refetch keeps the last good list on screen, with the error above it. */}
      {list.error && <InlineError error={list.error} onRetry={() => void list.mutate()} />}
      {!rows ? (
        !list.error && (
          <div className="flex flex-col gap-2" aria-busy>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          emptyMessage={q ? "No emergencies match this search." : "No emergencies match these filters."}
          getRowId={(r) => String(r.emergency_id)}
          onRowClick={(r) => router.push(`/emergencies/${r.emergency_id}`)}
        />
      )}
    </div>
  );
}
