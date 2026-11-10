import type { CenterStatus, CenterType, ResourceCategory, Role } from "./enums";

// JSON shapes of /api/admin/* (docs/HANDOFF.md P2.6), shared by the Route
// Handlers, the pages and the API tests. Client-safe.

/** One user. password_hash is never sent. */
export type AdminUserRow = {
  user_id: number;
  name: string;
  email: string;
  role: Role;
  center_id: number | null;
  center_name: string | null;
  is_active: boolean;
};

/** One resource. Once stock_count or item_count is above 0, its name and unit are locked. */
export type AdminResourceRow = {
  resource_id: number;
  name: string;
  category: ResourceCategory;
  unit: string;
  stock_count: number;
  item_count: number;
};

export type AdminCenterRow = {
  center_id: number;
  name: string;
  center_type: CenterType;
  status: CenterStatus;
  location_id: number;
  grid_id: string;
  batch_count: number;
  /** Users assigned here, active or not. A center with any can't be deleted. */
  user_count: number;
};

/** GET /api/locations (ADMIN and COORDINATOR): one location for the location picker. */
export type LocationRow = {
  location_id: number;
  grid_id: string;
  latitude: number;
  longitude: number;
};

/** One location in the admin list. Once center_count or impact_count is above 0, its grid id and coordinates are locked. */
export type AdminLocationRow = LocationRow & {
  center_count: number;
  impact_count: number;
};
