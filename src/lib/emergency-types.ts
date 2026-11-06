import type { EmergencyStatus, EmergencyType, ImpactStatus, Severity } from "./enums";

// JSON shapes of /api/emergencies/* and /api/impacts/* (docs/HANDOFF.md P2.1),
// shared by the Route Handlers and the pages. Type imports only: client-safe.
//
// Times are MySQL DATETIME strings, IST wall clock ("YYYY-MM-DD HH:MM:SS").
// Request counts are scoped to the caller for a FIELD_OFFICER (their own
// requests only) and global for ADMIN and COORDINATOR.

/** One row of GET /api/emergencies. */
export type EmergencyRow = {
  emergency_id: number;
  name: string;
  type: EmergencyType;
  status: EmergencyStatus;
  start_time: string;
  end_time: string | null;
  impact_count: number;
  request_count: number;
};

/** The emergency's own columns. */
export type EmergencyHeader = Omit<EmergencyRow, "impact_count" | "request_count"> & {
  description: string | null;
};

/** One impacted location, with its latest observation if it has any. */
export type ImpactRow = {
  impact_id: number;
  status: ImpactStatus;
  location_id: number;
  grid_id: string;
  latitude: number;
  longitude: number;
  latest_severity: Severity | null;
  latest_affected_pct: number | null;
  latest_observed_at: string | null;
  request_count: number;
};

/** The timeline's cap: enough to read, small after P2.3 seeds ~150 more reports. */
export const OBSERVATION_LIMIT = 200;

/** One entry of the observations timeline (newest first, at most OBSERVATION_LIMIT). */
export type ObservationRow = {
  observation_id: number;
  impact_id: number;
  grid_id: string;
  observed_at: string;
  severity: Severity;
  affected_percentage: number;
  observed_by: string;
};

/** GET /api/emergencies/[id] */
export type EmergencyDetail = {
  emergency: EmergencyHeader;
  impacts: ImpactRow[];
  observations: ObservationRow[];
  /**
   * observations: the real total, which `observations` above may be capped below.
   * open_items: PENDING / PARTIAL items in non-cancelled requests (they leave the queue on close).
   */
  counts: { observations: number; requests: number; open_items: number; reports: number };
};

/** POST /api/emergencies -> 201 */
export type EmergencyCreated = { emergency_id: number };

/** POST /api/emergencies/[id]/impacts -> 201. location_created is false when the grid_id existed; its stored coordinates are returned. */
export type ImpactCreated = {
  impact_id: number;
  location_id: number;
  location_created: boolean;
  grid_id: string;
  latitude: number;
  longitude: number;
};

/** PATCH /api/impacts/[id] */
export type ImpactUpdated = { impact_id: number; status: ImpactStatus };
