-- 02_alter.sql
-- Part 1 changes on top of the submitted schema (01_schema.sql). ALTERs only,
-- plus the new stock_ledger table. Allowed values follow docs/HANDOFF.md 4.3 and
-- are mirrored in src/lib/enums.ts.
--
-- CHECK constraint names are schema-wide in MySQL, so every new one is named
-- chk_<table>_<column>.

-- ---------------------------------------------------------------------------
-- user: login, center scope, soft delete
-- ---------------------------------------------------------------------------

-- password_hash: bcryptjs hash. center_id: set only for CENTER_MANAGER users;
-- it becomes NULL if their center is deleted. is_active: users are deactivated,
-- never hard-deleted.
ALTER TABLE `user`
    ADD COLUMN password_hash VARCHAR(255) NOT NULL AFTER email,
    ADD COLUMN center_id INT NULL AFTER role_id,
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD CONSTRAINT fk_user_center
        FOREIGN KEY (center_id)
        REFERENCES resource_center(center_id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,
    ADD CONSTRAINT chk_user_email
        CHECK (email LIKE '%_@_%._%');

-- ---------------------------------------------------------------------------
-- Allowed values (HANDOFF 4.3)
-- ---------------------------------------------------------------------------

ALTER TABLE role
    ADD CONSTRAINT chk_role_role_name
        CHECK (role_name IN ('ADMIN', 'COORDINATOR', 'FIELD_OFFICER', 'CENTER_MANAGER'));

ALTER TABLE emergency
    ADD CONSTRAINT chk_emergency_type
        CHECK (type IN ('FLOOD', 'EARTHQUAKE', 'CYCLONE', 'FIRE',
                        'LANDSLIDE', 'EPIDEMIC', 'HEATWAVE', 'OTHER')),
    ADD CONSTRAINT chk_emergency_status
        CHECK (status IN ('ACTIVE', 'CONTAINED', 'CLOSED'));

ALTER TABLE emergency_impact
    ADD CONSTRAINT chk_emergency_impact_status
        CHECK (status IN ('ACTIVE', 'STABILISED', 'RESOLVED'));

ALTER TABLE impact_observation
    ADD CONSTRAINT chk_impact_observation_severity
        CHECK (severity IN ('LOW', 'MODERATE', 'HIGH', 'CRITICAL'));

ALTER TABLE resource
    ADD CONSTRAINT chk_resource_category
        CHECK (category IN ('FOOD', 'WATER', 'MEDICAL', 'SHELTER',
                            'HYGIENE', 'RESCUE', 'POWER', 'OTHER'));

ALTER TABLE resource_center
    ADD CONSTRAINT chk_resource_center_center_type
        CHECK (center_type IN ('WAREHOUSE', 'HOSPITAL', 'RELIEF_CAMP', 'DEPOT')),
    ADD CONSTRAINT chk_resource_center_status
        CHECK (status IN ('OPERATIONAL', 'LIMITED', 'CLOSED'));

-- New requests start OPEN; triggers roll the status up from the items.
ALTER TABLE resource_request
    ALTER COLUMN status SET DEFAULT 'OPEN',
    ADD CONSTRAINT chk_resource_request_status
        CHECK (status IN ('OPEN', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED'));

-- New items start PENDING; triggers set PARTIAL / FULFILLED.
ALTER TABLE request_item
    ALTER COLUMN status SET DEFAULT 'PENDING',
    ADD CONSTRAINT chk_request_item_urgency
        CHECK (urgency IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    ADD CONSTRAINT chk_request_item_status
        CHECK (status IN ('PENDING', 'PARTIAL', 'FULFILLED', 'CANCELLED'));

-- quantity_allocated: sum of the item's allocations that aren't CANCELLED. Kept
-- by the allocation triggers only (06_triggers.sql); hand edits are refused.
-- The rules read it from the locked item row instead of summing allocation
-- rows, because inside a trigger that sum is a locking read and deadlocks with
-- a concurrent cancel. The CHECK is the backstop behind the triggers' messages.
ALTER TABLE request_item
    ADD COLUMN quantity_allocated DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER quantity_requested,
    ADD CONSTRAINT chk_request_item_quantity_allocated
        CHECK (quantity_allocated BETWEEN 0 AND quantity_requested);

-- New allocations start RESERVED; transitions are enforced by trigger.
ALTER TABLE allocation
    ALTER COLUMN status SET DEFAULT 'RESERVED',
    ADD CONSTRAINT chk_allocation_status
        CHECK (status IN ('RESERVED', 'DISPATCHED', 'DELIVERED', 'CANCELLED'));

-- ---------------------------------------------------------------------------
-- stock_ledger: one row per change to stock.quantity_available, written by
-- triggers (06_triggers.sql). balance_after is the quantity after the change.
-- ---------------------------------------------------------------------------

CREATE TABLE stock_ledger (
    ledger_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    stock_id INT NOT NULL,
    change_qty DECIMAL(12,2) NOT NULL,
    balance_after DECIMAL(12,2) NOT NULL,
    reason VARCHAR(30) NOT NULL,
    allocation_id INT NULL,
    changed_by INT NULL,
    changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_stock_ledger_stock
        FOREIGN KEY (stock_id)
        REFERENCES stock(stock_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_stock_ledger_allocation
        FOREIGN KEY (allocation_id)
        REFERENCES allocation(allocation_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT fk_stock_ledger_user
        FOREIGN KEY (changed_by)
        REFERENCES `user`(user_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_stock_ledger_change_qty
        CHECK (change_qty <> 0),

    CONSTRAINT chk_stock_ledger_reason
        CHECK (reason IN ('RECEIPT', 'ALLOCATION', 'ALLOCATION_CANCELLED',
                          'ADJUSTMENT', 'WRITE_OFF')),

    -- Per-batch history in time order (ledger view, reconciliation query 11).
    -- Also serves fk_stock_ledger_stock.
    INDEX idx_stock_ledger_stock_time (stock_id, changed_at)
);

-- ---------------------------------------------------------------------------
-- Index review
-- ---------------------------------------------------------------------------

-- Allocation queue: WHERE status IN ('PENDING','PARTIAL') [AND urgency = ...].
CREATE INDEX idx_item_queue ON request_item(status, urgency);

-- FEFO batch pick: one resource's batches in expiry order.
CREATE INDEX idx_stock_fefo ON stock(resource_id, expiry_date);

-- Redundant single-column indexes. Each column is already the leftmost part of
-- another index, which serves both lookups and its foreign key. The covering
-- indexes are created above or in 01, so the FKs always keep an index.

-- emergency_id is covered by UNIQUE uq_emergency_location (emergency_id, location_id).
DROP INDEX idx_impact_emergency ON emergency_impact;

-- impact_id is covered by UNIQUE uq_impact_observation_time (impact_id, observed_at).
DROP INDEX idx_observation_impact ON impact_observation;

-- center_id is covered by UNIQUE uq_stock_batch (center_id, resource_id, batch_code).
DROP INDEX idx_stock_center ON stock;

-- resource_id is covered by idx_stock_fefo (resource_id, expiry_date), added above.
DROP INDEX idx_stock_resource ON stock;

-- request_id is covered by UNIQUE uq_request_resource (request_id, resource_id).
DROP INDEX idx_request_item_request ON request_item;
