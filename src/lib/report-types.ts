import type { EmergencyStatus, EmergencyType, Severity } from "./enums";
import type { TRENDS } from "./validators/observations";

// JSON shapes of /api/reports/* (docs/HANDOFF.md P2.3), shared by the Route
// Handlers and the pages. Client-safe.
//
// Every time is an IST wall-clock string ("YYYY-MM-DD HH:MM:SS"). A report is
// identified by its observation_id. The MySQL fields are null only for a report
// whose observation row is missing (HANDOFF 4.4's known gap).

export type Trend = (typeof TRENDS)[number];

/** The most reports one list returns. */
export const REPORT_LIST_CAP = 200;

/** One row of GET /api/reports. */
export type ReportRow = {
  observation_id: number;
  emergency_id: number;
  impact_id: number;
  emergency_type: EmergencyType;
  reported_at: string;
  latitude: number;
  longitude: number;
  trend: Trend | null;
  reporter: string;
  /** Metres from the searched point; null unless this is a near search. */
  distance_m: number | null;
  severity: Severity | null;
  affected_percentage: number | null;
  observed_at: string | null;
  grid_id: string | null;
  emergency_name: string | null;
  emergency_status: EmergencyStatus | null;
};

/** GET /api/reports */
export type ReportList = {
  reports: ReportRow[];
  /** Every match, which `reports` above may be capped below. */
  total: number;
  capped: boolean;
};

/** POST /api/observations -> 201 */
export type ReportFiled = { observation_id: number; reported_at: string };

export type ReportNeed ={ item: string; est_qty?: number; unit?: string };
export type ReportInfrastructure = { kind: string; name?: string; status?: string };
export type ReportCasualties = { injured?: number; missing?: number; deceased?: number };

/** GET /api/reports/[id] */
export type ReportDetail = ReportRow & {
  /** Its shape depends on emergency_type. */
  details: Record<string, unknown>;
  casualties: ReportCasualties | null;
  needs_observed: ReportNeed[];
  infrastructure: ReportInfrastructure[];
  notes: string | null;
  tags: string[];
  photos: string[];
};
