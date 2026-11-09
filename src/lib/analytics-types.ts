import type { EmergencyStatus, EmergencyType, ImpactStatus, ResourceCategory, Severity } from "./enums";

// JSON shapes of /api/analytics/* (docs/HANDOFF.md P2.5), shared by the Route
// Handlers, the pages and the API tests. Client-safe.

/** One row of v_unmet_demand: an emergency x resource with live requested items. */
export type UnmetRow = {
  emergency_id: number;
  emergency_name: string;
  emergency_status: EmergencyStatus;
  resource_id: number;
  resource_name: string;
  category: ResourceCategory;
  unit: string;
  item_count: number;
  quantity_requested: number;
  quantity_allocated: number;
  quantity_unmet: number;
};

/** One row of v_fulfilment_rate. The rates are null when the emergency has no live items. */
export type FulfilmentRow = {
  emergency_id: number;
  emergency_name: string;
  emergency_type: EmergencyType;
  emergency_status: EmergencyStatus;
  items_total: number;
  items_fulfilled: number;
  items_partial: number;
  items_pending: number;
  /** Fulfilled items / live items. */
  item_rate_pct: number | null;
  /** Each item's allocated / requested share, averaged, so units aren't added together. */
  quantity_rate_pct: number | null;
};

/** One row of v_escalating_impacts: the latest observation is worse than the one before. */
export type EscalatingRow = {
  emergency_id: number;
  emergency: string;
  emergency_status: EmergencyStatus;
  impact_id: number;
  impact_status: ImpactStatus;
  grid_id: string;
  severity: Severity;
  prev_severity: Severity;
  sev_rank: number;
  prev_rank: number;
  observed_at: string;
};

/** DIFFERENT_UNIT: reports name a requested resource in a unit it isn't measured in, so nobody can say it's unrequested. */
export const GAP_STATUSES = ["OBSERVED_ONLY", "BOTH", "DIFFERENT_UNIT", "REQUESTED_ONLY"] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

/**
 * One need of the field-vs-request gap. The observed figures are null or 0 on a
 * REQUESTED_ONLY row, and the requested ones null on an OBSERVED_ONLY row.
 * observed_quantity adds every report's estimate, so a need seen repeatedly
 * counts repeatedly: it sits beside the requested figures and is never subtracted.
 */
export type GapRow = {
  /** Unique within the response. */
  key: string;
  item: string;
  unit: string | null;
  status: GapStatus;
  /** False for a free-text need that names no resource. */
  in_catalogue: boolean;
  /** True when reports use a different unit from the resource's, so it can't be compared. */
  unit_differs: boolean;
  observed_quantity: number | null;
  mentions: number;
  quantity_requested: number | null;
  quantity_allocated: number | null;
  quantity_unmet: number | null;
};

/** GET /api/analytics/gap */
export type GapData = {
  emergency: { emergency_id: number; name: string; type: EmergencyType; status: EmergencyStatus };
  rows: GapRow[];
  counts: Record<GapStatus, number>;
};
