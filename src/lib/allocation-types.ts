import type {
  AllocationStatus,
  CenterStatus,
  EmergencyStatus,
  ImpactStatus,
  ItemStatus,
  RequestStatus,
  Severity,
  Urgency,
} from "./enums";

// Rows and responses of /api/allocations/* (docs/HANDOFF.md 4.9), shared by the
// Route Handlers and the /allocate page. Type imports only, so client code can
// use it. DECIMALs arrive as numbers, DATETIME / DATE as IST wall-clock strings.

/** GET /api/allocations/queue: one v_priority_queue row, plus its score contributions and usable stock. */
export type QueueRow = {
  request_item_id: number;
  request_id: number;
  item_status: ItemStatus;
  emergency_id: number;
  emergency_name: string;
  emergency_status: EmergencyStatus;
  impact_id: number;
  impact_status: ImpactStatus;
  grid_id: string;
  latitude: number;
  longitude: number;
  resource_id: number;
  resource_name: string;
  unit: string;
  quantity_requested: number;
  quantity_allocated: number;
  quantity_remaining: number;
  urgency: Urgency;
  latest_severity: Severity | null;
  latest_affected_pct: number | null;
  latest_observed_at: string | null;
  requested_at: string;
  required_by: string | null;
  hours_waiting: number;
  /** Score inputs, 0–1 (Appendix C). */
  u_part: number;
  s_part: number;
  a_part: number;
  w_part: number;
  d_part: number;
  priority_score: number;
  /** What each part adds to the score (fn_priority_from_parts with the others at 0). */
  u_points: number;
  s_points: number;
  a_points: number;
  w_points: number;
  d_points: number;
  /** Usable stock of this resource at centers that aren't CLOSED (0 when none). */
  usable_qty: number;
};

/** GET /api/allocations/suggestions?item=: one sp_suggest_batches row, best first. */
export type SuggestionRow = {
  stock_id: number;
  batch_code: string;
  center_id: number;
  center_name: string;
  center_status: CenterStatus;
  quantity_available: number;
  expiry_date: string | null;
  /** 0 = expires today; null = no expiry date. */
  days_left: number | null;
  distance_km: number;
  suggestion_rank: number;
  suggested_qty: number;
};

/** One item's current state, whether or not it's in the queue. */
export type ItemState = {
  request_item_id: number;
  request_id: number;
  request_status: RequestStatus;
  item_status: ItemStatus;
  resource_id: number;
  resource_name: string;
  unit: string;
  quantity_requested: number;
  quantity_allocated: number;
  quantity_remaining: number;
  urgency: Urgency;
  emergency_id: number;
  emergency_name: string;
  emergency_status: EmergencyStatus;
  grid_id: string;
};

/** One allocation of an item, with its batch and who made it. */
export type AllocationRow = {
  allocation_id: number;
  request_item_id: number;
  stock_id: number;
  batch_code: string;
  center_id: number;
  center_name: string;
  center_status: CenterStatus;
  status: AllocationStatus;
  quantity_allocated: number;
  allocated_at: string;
  allocated_by: string;
};

/** GET /api/allocations?item= */
export type ItemAllocations = { item: ItemState; allocations: AllocationRow[] };

/** POST /api/allocations → 201 */
export type CreateAllocationsResult = {
  allocations: { allocation_id: number; stock_id: number; quantity: number }[];
  item: ItemState;
};

/** POST /api/allocations/[id]/cancel → 200 */
export type CancelAllocationResult = { allocation: AllocationRow; item: ItemState };
