// Allowed values (docs/HANDOFF.md 4.3), mirroring the CHECK constraints in
// db/mysql/02_alter.sql. `npm run db:enums` compares the two.
//
// No imports: this file is shared by server code, client code and scripts.

export const ROLES = ["ADMIN", "COORDINATOR", "FIELD_OFFICER", "CENTER_MANAGER"] as const;
export type Role = (typeof ROLES)[number];

export const EMERGENCY_TYPES = [
  "FLOOD",
  "EARTHQUAKE",
  "CYCLONE",
  "FIRE",
  "LANDSLIDE",
  "EPIDEMIC",
  "HEATWAVE",
  "OTHER",
] as const;
export type EmergencyType = (typeof EMERGENCY_TYPES)[number];

export const EMERGENCY_STATUSES = ["ACTIVE", "CONTAINED", "CLOSED"] as const;
export type EmergencyStatus = (typeof EMERGENCY_STATUSES)[number];

export const IMPACT_STATUSES = ["ACTIVE", "STABILISED", "RESOLVED"] as const;
export type ImpactStatus = (typeof IMPACT_STATUSES)[number];

export const SEVERITIES = ["LOW", "MODERATE", "HIGH", "CRITICAL"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RESOURCE_CATEGORIES = [
  "FOOD",
  "WATER",
  "MEDICAL",
  "SHELTER",
  "HYGIENE",
  "RESCUE",
  "POWER",
  "OTHER",
] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const CENTER_TYPES = ["WAREHOUSE", "HOSPITAL", "RELIEF_CAMP", "DEPOT"] as const;
export type CenterType = (typeof CENTER_TYPES)[number];

export const CENTER_STATUSES = ["OPERATIONAL", "LIMITED", "CLOSED"] as const;
export type CenterStatus = (typeof CENTER_STATUSES)[number];

/** Rolled up by trigger from the items; new requests start OPEN. */
export const REQUEST_STATUSES = ["OPEN", "PARTIALLY_FULFILLED", "FULFILLED", "CANCELLED"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const URGENCIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Urgency = (typeof URGENCIES)[number];

/** PARTIAL / FULFILLED are set by trigger; new items start PENDING. */
export const ITEM_STATUSES = ["PENDING", "PARTIAL", "FULFILLED", "CANCELLED"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** RESERVED -> DISPATCHED -> DELIVERED; RESERVED or DISPATCHED -> CANCELLED. */
export const ALLOCATION_STATUSES = ["RESERVED", "DISPATCHED", "DELIVERED", "CANCELLED"] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

export const LEDGER_REASONS = [
  "RECEIPT",
  "ALLOCATION",
  "ALLOCATION_CANCELLED",
  "ADJUSTMENT",
  "WRITE_OFF",
] as const;
export type LedgerReason = (typeof LEDGER_REASONS)[number];
