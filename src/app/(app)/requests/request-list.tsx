"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { InlineError } from "@/app/(app)/allocate/bits";
import { humanizedOptions, withQuery } from "@/app/(app)/emergencies/format";
import { DataTable } from "@/components/data-table";
import { ALL, FilterSelect } from "@/components/filter-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLastValue } from "@/hooks/use-last-value";
import { useApi } from "@/lib/client";
import type { EmergencyRow } from "@/lib/emergency-types";
import { REQUEST_STATUSES, URGENCIES } from "@/lib/enums";
import type { RequestRow } from "@/lib/request-types";
import { MAX_SEARCH_LENGTH } from "@/lib/validators/fields";
import { requestColumns } from "./request-columns";

// /requests: the filters and full-text search run in MySQL through the query
// string; DataTable sorts and pages what comes back. The API limits a Field
// Officer to their own requests.

export function RequestList({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [emergency, setEmergency] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [urgency, setUrgency] = useState(ALL);
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(search.trim());

  const emergencies = useApi<EmergencyRow[]>("/api/emergencies");
  const list = useApi<RequestRow[]>(
    withQuery("/api/requests", {
      emergency: emergency === ALL ? undefined : emergency,
      status: status === ALL ? undefined : status,
      urgency: urgency === ALL ? undefined : urgency,
      q,
    }),
  );

  const rows = useLastValue(list.data);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search descriptions…"
          aria-label="Search requests"
          maxLength={MAX_SEARCH_LENGTH}
          className="w-full sm:w-64"
        />
        <FilterSelect
          label="emergency"
          allLabel="All emergencies"
          value={emergency}
          onChange={setEmergency}
          options={(emergencies.data ?? []).map((e) => ({ value: String(e.emergency_id), label: e.name }))}
          className="w-48"
        />
        <FilterSelect
          label="status"
          allLabel="All statuses"
          value={status}
          onChange={setStatus}
          options={humanizedOptions(REQUEST_STATUSES)}
          className="w-48"
        />
        <FilterSelect
          label="urgency"
          allLabel="Any urgency"
          value={urgency}
          onChange={setUrgency}
          options={humanizedOptions(URGENCIES)}
          className="w-48"
        />
        {canCreate && (
          <Button size="sm" asChild className="ml-auto">
            <Link href="/requests/new">
              <Plus />
              New request
            </Link>
          </Button>
        )}
      </div>

      {emergencies.error && <InlineError error={emergencies.error} onRetry={() => void emergencies.mutate()} />}
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
          columns={requestColumns}
          data={rows}
          emptyMessage={q ? "No requests match this search." : "No requests match these filters."}
          getRowId={(r) => String(r.request_id)}
          onRowClick={(r) => router.push(`/requests/${r.request_id}`)}
        />
      )}
    </div>
  );
}
