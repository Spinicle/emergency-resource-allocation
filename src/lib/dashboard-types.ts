import type { ActivityEntityType, ActivityRefs } from "./activity";
import type { CenterStatus, CenterType, EmergencyType, ImpactStatus, Role, Severity } from "./enums";
import type { ReportRow, Trend } from "./report-types";
import type { TimelineEntry } from "./request-types";

// JSON shape of GET /api/dashboard (docs/HANDOFF.md P2.4), shared by the Route
// Handler, the page and the API tests. Client-safe.
//
// Every time is an IST wall-clock string, and every day an IST date.

/** How many IST days the report charts cover, ending today. */
export const REPORT_WINDOW_DAYS = 14;
/** The most needs topNeeds returns. */
export const TOP_NEEDS_LIMIT = 10;
/** How many reports summary.latest holds. */
export const LATEST_REPORTS_LIMIT = 5;
/** How many entries recentActivity holds. */
export const ACTIVITY_FEED_LIMIT = 15;

export type DashboardKpis = {
  active_emergencies: number;
  /** A Field Officer: their own. A Center Manager: the ones their center can supply. */
  open_items: number;
  critical_items: number;
  /** null for a Field Officer, who has no access to stock. */
  expiring_batches: number | null;
  out_of_stock: number | null;
};

/** One IST day of field reports; `counts` holds only the types reported that day. */
export type ReportDayBucket = {
  day: string;
  total: number;
  counts: Partial<Record<EmergencyType, number>>;
};

export type TopNeed = { item: string; unit: string | null; quantity: number };

export type ReportSummary = {
  total: number;
  /** Most reports first. */
  byType: { type: EmergencyType; count: number }[];
  /** Every trend, then null for reports that don't give one. */
  byTrend: { trend: Trend | null; count: number }[];
  /** Newest first. Always empty for a Center Manager, who can't open reports. */
  latest: ReportRow[];
};

/** One activity_log entry on the dashboard's feed, newest first. */
export type DashboardActivityEntry = TimelineEntry & {
  entity_type: ActivityEntityType;
  /** null only for a ledger row made outside the app. */
  actor_user_id: number | null;
  refs: ActivityRefs | null;
};

/** An impact of an emergency that isn't CLOSED. */
export type DashboardImpact = {
  impact_id: number;
  status: ImpactStatus;
  grid_id: string;
  latitude: number;
  longitude: number;
  emergency_name: string;
  /** null until the impact has an observation. */
  latest_severity: Severity | null;
};

export type DashboardCenter = {
  center_id: number;
  name: string;
  center_type: CenterType;
  status: CenterStatus;
  latitude: number;
  longitude: number;
};

/** GET /api/dashboard */
export type DashboardData = {
  role: Role;
  kpis: DashboardKpis;
  reportsByDay: ReportDayBucket[];
  topNeeds: TopNeed[];
  summary: ReportSummary;
  recentActivity: DashboardActivityEntry[];
  impacts: DashboardImpact[];
  centers: DashboardCenter[];
};
