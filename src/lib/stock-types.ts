import type { AllocationRow } from "./allocation-types";
import type { AllocationStatus, CenterStatus, LedgerReason, ResourceCategory } from "./enums";

// Rows and responses of /api/stock/* and /api/resources (docs/HANDOFF.md 4.10),
// shared by the Route Handlers and P2.6's /inventory. Type imports only, so
// client code can use it. DECIMALs arrive as numbers, DATETIME / DATE as IST
// wall-clock strings.

/** GET /api/resources */
export type ResourceRow = { resource_id: number; name: string; category: ResourceCategory; unit: string };

/** One batch (GET /api/stock, and the batch in receive/adjust responses). */
export type StockRow = {
  stock_id: number;
  batch_code: string;
  resource_id: number;
  resource_name: string;
  category: ResourceCategory;
  unit: string;
  center_id: number;
  center_name: string;
  center_status: CenterStatus;
  quantity_available: number;
  expiry_date: string | null;
  /** Days until expiry: 0 = today, negative = expired, null = no expiry date. */
  days_left: number | null;
  /** HANDOFF 4.4's one rule: quantity > 0 and not expired. */
  usable: boolean;
};

/** One stock_ledger row (GET /api/stock/[id]/ledger, and the row a receive/adjust wrote). */
export type LedgerRow = {
  ledger_id: number;
  stock_id: number;
  changed_at: string;
  reason: LedgerReason;
  change_qty: number;
  balance_after: number;
  allocation_id: number | null;
  /** The user's name, or "Database console" for a change made outside the app. */
  changed_by: string;
};

/** GET /api/stock/allocations: one allocation from a center's batches. */
export type CenterAllocationRow = {
  allocation_id: number;
  request_item_id: number;
  request_id: number;
  stock_id: number;
  batch_code: string;
  center_id: number;
  center_name: string;
  resource_name: string;
  unit: string;
  quantity_allocated: number;
  status: AllocationStatus;
  emergency_id: number;
  emergency_name: string;
  grid_id: string;
  allocated_at: string;
  allocated_by: string;
};

/** POST /api/stock → 201, POST /api/stock/[id]/adjust → 200 */
export type StockChangeResult = { batch: StockRow; ledger: LedgerRow };

/** POST /api/stock/allocations/[id]/dispatch | deliver → 200 */
export type AllocationStatusResult = { allocation: AllocationRow };
