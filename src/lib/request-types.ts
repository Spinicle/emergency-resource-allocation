import type { ActivityAction, ActivityEntityType } from "./activity";
import type { AllocationStatus, EmergencyStatus, ItemStatus, RequestStatus, Role, Urgency } from "./enums";

// JSON shapes of /api/requests/* (docs/HANDOFF.md P2.2), shared by the Route
// Handlers and the pages. Type imports only: client-safe.
//
// Every time is an IST wall-clock string ("YYYY-MM-DD HH:MM:SS"), including the
// timeline's, which the route converts from MongoDB's UTC instants.

/** One row of GET /api/requests. */
export type RequestRow = {
  request_id: number;
  status: RequestStatus;
  requested_at: string;
  required_by: string | null;
  description: string | null;
  impact_id: number;
  grid_id: string;
  emergency_id: number;
  emergency_name: string;
  requested_by: string;
  item_count: number;
  top_urgency: Urgency | null;
};

/** The request's own details on its page. */
export type RequestHeader = Omit<RequestRow, "item_count" | "top_urgency"> & { emergency_status: EmergencyStatus };

/** One item of a request. */
export type RequestItemRow = {
  request_item_id: number;
  resource_id: number;
  resource_name: string;
  unit: string;
  quantity_requested: number;
  quantity_allocated: number;
  quantity_remaining: number;
  urgency: Urgency;
  status: ItemStatus;
};

/** One allocation against a request, with the batch and center it came from. */
export type RequestAllocationRow = {
  allocation_id: number;
  request_item_id: number;
  resource_name: string;
  unit: string;
  quantity_allocated: number;
  status: AllocationStatus;
  allocated_at: string;
  batch_code: string;
  expiry_date: string | null;
  center_name: string;
  allocated_by: string;
};

/** The timeline's cap: a request's newest events. */
export const TIMELINE_LIMIT = 200;

/** One activity_log entry on the request's timeline (newest first, at most TIMELINE_LIMIT). */
export type TimelineEntry = {
  ts: string;
  action: ActivityAction;
  actor_name: string;
  actor_role: Role | null;
  entity_type: ActivityEntityType;
  entity_id: number;
  payload: Record<string, unknown> | null;
};

/** GET /api/requests/[id] */
export type RequestDetail = {
  request: RequestHeader;
  items: RequestItemRow[];
  allocations: RequestAllocationRow[];
  timeline: TimelineEntry[];
};

/** POST /api/requests -> 201 */
export type RequestCreated = { request_id: number };

/** POST /api/requests/[id]/cancel */
export type RequestCancelled = { request_id: number; status: "CANCELLED" };
