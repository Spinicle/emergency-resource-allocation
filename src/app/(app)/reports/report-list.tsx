"use client";

import { List, Map as MapIcon, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { InlineError } from "@/app/(app)/allocate/bits";
import { formatIst } from "@/app/(app)/allocate/format";
import { humanize, humanizedOptions, withQuery } from "@/app/(app)/emergencies/format";
import { DataTable } from "@/components/data-table";
import { ALL, FilterSelect } from "@/components/filter-select";
import { FormField } from "@/components/form-field";
import { ErasMap, type MapPoint, severityColor } from "@/components/map";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLastValue } from "@/hooks/use-last-value";
import { useApi } from "@/lib/client";
import type { EmergencyDetail, EmergencyRow } from "@/lib/emergency-types";
import { EMERGENCY_TYPES } from "@/lib/enums";
import type { ReportList as ReportListData } from "@/lib/report-types";
import { MAX_SEARCH_LENGTH } from "@/lib/validators/fields";
import { DEFAULT_NEAR_KM, MAX_NEAR_KM, MIN_NEAR_KM } from "@/lib/validators/reports";
import { nearReportColumns, reportColumns } from "./report-columns";

// /reports: filters, text search and near search run in MongoDB through the
// query string; DataTable sorts and pages what comes back. The URL holds the
// filters, so a search can be reloaded or shared. Text and near are exclusive,
// as they are in the API.

type Mode = "text" | "near";

export function ReportList() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const mode: Mode = params.get("mode") === "near" ? "near" : "text";
  const emergency = params.get("emergency") ?? ALL;
  const type = params.get("type") ?? ALL;
  const impact = params.get("impact") ?? "";
  const showMap = params.get("view") === "map";

  const [search, setSearch] = useState(params.get("q") ?? "");
  const q = useDebouncedValue(search.trim());
  const [kmText, setKmText] = useState(params.get("km") ?? String(DEFAULT_NEAR_KM));
  const km = useDebouncedValue(kmText.trim());
  const kmNumber = km === "" ? Number.NaN : Number(km);
  const kmValid = kmNumber >= MIN_NEAR_KM && kmNumber <= MAX_NEAR_KM;

  /** Rewrites the given query-string values; undefined or "" removes one. */
  const setParams = useCallback(
    (changes: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const text = next.toString();
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  // The search boxes hold what's being typed; the URL follows once it settles.
  useEffect(() => {
    const urlQ = mode === "text" ? q : "";
    const urlKm = mode === "near" && kmValid && km !== String(DEFAULT_NEAR_KM) ? km : "";
    if (urlQ !== (params.get("q") ?? "") || urlKm !== (params.get("km") ?? "")) {
      setParams({ q: urlQ, km: urlKm });
    }
  }, [mode, q, km, kmValid, params, setParams]);

  const emergencies = useApi<EmergencyRow[]>("/api/emergencies");
  // Near mode picks from the chosen emergency's impacts; no API lists every impact.
  const detail = useApi<EmergencyDetail>(mode === "near" && emergency !== ALL ? `/api/emergencies/${emergency}` : null);
  const selectedImpact = detail.data?.impacts.find((i) => String(i.impact_id) === impact);
  const near = mode === "near" && selectedImpact ? `${selectedImpact.latitude},${selectedImpact.longitude}` : undefined;

  const list = useApi<ReportListData>(
    // A km out of range is flagged at the box; keep the last rows until it's fixed.
    mode === "near" && !kmValid
      ? null
      : withQuery("/api/reports", {
          emergency: emergency === ALL ? undefined : emergency,
          type: type === ALL ? undefined : type,
          q: mode === "text" ? q : undefined,
          near,
          km: near ? km : undefined,
        }),
  );
  const data = useLastValue(list.data);
  const rows = data?.reports;

  const points = useMemo<MapPoint[]>(
    () =>
      (rows ?? []).map((r) => ({
        id: String(r.observation_id),
        lat: r.latitude,
        lng: r.longitude,
        color: severityColor(r.severity),
        label: `${r.grid_id ?? "Unknown location"} · ${r.severity ? humanize(r.severity) : "no severity"} · ${formatIst(r.reported_at)}`,
        onClick: () => router.push(`/reports/${r.observation_id}`),
      })),
    [rows, router],
  );

  function switchMode(next: Mode) {
    if (next === mode) return;
    setSearch("");
    setKmText(String(DEFAULT_NEAR_KM));
    setParams({ mode: next === "near" ? "near" : undefined, q: undefined, km: undefined, impact: undefined });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex gap-1" role="group" aria-label="Search by">
          <Button size="sm" variant={mode === "text" ? "default" : "outline"} onClick={() => switchMode("text")}>
            Text
          </Button>
          <Button size="sm" variant={mode === "near" ? "default" : "outline"} onClick={() => switchMode("near")}>
            Near an impact
          </Button>
        </div>
        <FilterSelect
          label="emergency"
          allLabel="All emergencies"
          value={emergency}
          onChange={(value) => setParams({ emergency: value === ALL ? undefined : value, impact: undefined })}
          options={(emergencies.data ?? []).map((e) => ({ value: String(e.emergency_id), label: e.name }))}
          className="w-48"
        />
        <FilterSelect
          label="type"
          allLabel="All types"
          value={type}
          onChange={(value) => setParams({ type: value === ALL ? undefined : value })}
          options={humanizedOptions(EMERGENCY_TYPES)}
          className="w-40"
        />
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setParams({ view: showMap ? undefined : "map" })}
          >
            {showMap ? <List /> : <MapIcon />}
            {showMap ? "Table" : "Map"}
          </Button>
          <Button size="sm" asChild>
            <Link href="/reports/new">
              <Plus />
              File a report
            </Link>
          </Button>
        </div>
      </div>

      {mode === "text" ? (
        <div className="flex flex-col gap-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search field reports…"
            aria-label="Search field reports"
            maxLength={MAX_SEARCH_LENGTH}
            className="w-full sm:w-96"
          />
          <p className="text-sm text-muted-foreground">
            Searches notes and observed needs. Matches any word; put a phrase in &quot;quotes&quot;.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          <FormField htmlFor="near-impact" label="Impacted location">
            <Select value={impact} onValueChange={(value) => setParams({ impact: value })} disabled={!detail.data}>
              <SelectTrigger id="near-impact" className="w-64">
                <SelectValue placeholder={emergency === ALL ? "Choose an emergency first" : "Choose a location"} />
              </SelectTrigger>
              <SelectContent>
                {detail.data?.impacts.map((i) => (
                  <SelectItem key={i.impact_id} value={String(i.impact_id)}>
                    {i.grid_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField
            htmlFor="near-km"
            label="Within (km)"
            error={kmValid ? undefined : `Enter ${MIN_NEAR_KM} to ${MAX_NEAR_KM}`}
          >
            <Input
              id="near-km"
              type="number"
              min={MIN_NEAR_KM}
              max={MAX_NEAR_KM}
              step="any"
              value={kmText}
              onChange={(e) => setKmText(e.target.value)}
              aria-invalid={!kmValid}
              className="w-28"
            />
          </FormField>
        </div>
      )}

      {emergencies.error && <InlineError error={emergencies.error} onRetry={() => void emergencies.mutate()} />}
      {detail.error && <InlineError error={detail.error} onRetry={() => void detail.mutate()} />}
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
      ) : showMap ? (
        <ErasMap points={points} height="32rem" />
      ) : (
        <DataTable
          columns={near ? nearReportColumns : reportColumns}
          data={rows}
          emptyMessage={q || near ? "No reports match this search." : "No reports match these filters."}
          getRowId={(r) => String(r.observation_id)}
          onRowClick={(r) => router.push(`/reports/${r.observation_id}`)}
        />
      )}
      {data?.capped && (
        <p className="text-muted-foreground">
          Showing the first {data.reports.length} of {data.total} reports. Narrow the filters to see the rest.
        </p>
      )}
    </div>
  );
}
