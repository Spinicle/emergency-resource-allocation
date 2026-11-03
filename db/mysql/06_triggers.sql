-- 06_triggers.sql
-- The rules for stock, allocations and statuses (docs/HANDOFF.md 4.4). They hold
-- whatever the entry point is: a procedure, plain SQL from the app, or a console.
--
-- Invariants
--   1. Stock never goes negative. Every change to stock.quantity_available writes
--      exactly one stock_ledger row; a zero change writes none.
--   2. An allocation comes from a usable batch of the item's resource, at a
--      center that isn't CLOSED, for a PENDING/PARTIAL item in an emergency that
--      isn't CLOSED, and never takes the item past quantity_requested.
--   3. Allocations start RESERVED and move RESERVED -> DISPATCHED -> DELIVERED, or
--      RESERVED/DISPATCHED -> CANCELLED. Every other column is fixed.
--   4. Allocating takes stock (ledger ALLOCATION); cancelling returns it
--      (ALLOCATION_CANCELLED). Both ledger rows carry the allocation_id.
--   5. Item status is derived from its allocations (CANCELLED stays CANCELLED).
--   6. Request status is rolled up from its items.
--
-- Locking. Checks and recomputes lock rows FOR UPDATE in one order before they
-- read anything else:
--   new allocation:   request_item -> resource_request -> stock (center, emergency FOR SHARE)
--   cancel:           allocation row (taken by the UPDATE) -> request_item -> resource_request -> stock
--   item change:      request_item (taken by the UPDATE) -> resource_request
-- The allocate and cancel paths never read other allocation rows: what an item
-- has allocated is request_item.quantity_allocated, read from the locked item
-- row. (Summing allocation rows here would take shared locks on them, and an
-- allocation would then wait on a row a concurrent cancel holds while that
-- cancel waits for the item: a deadlock.)
--
-- No trigger modifies allocation or a table of the statement that fired it
-- (MySQL error 1442). Triggers run as their DEFINER (the db:reset admin).

DELIMITER $$

-- ===========================================================================
-- Status helpers: one definition shared by the triggers and their guards
-- ===========================================================================

-- Sum of an item's allocations that aren't CANCELLED: the definition that
-- request_item.quantity_allocated must always equal. The triggers don't call it
-- (see Locking above); tests and reconciliation queries do.
DROP FUNCTION IF EXISTS fn_item_allocated $$
CREATE FUNCTION fn_item_allocated(p_item_id INT)
RETURNS DECIMAL(12,2)
NOT DETERMINISTIC
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'Quantity allocated to an item (allocations not CANCELLED)'
BEGIN
    RETURN (SELECT COALESCE(SUM(a.quantity_allocated), 0)
              FROM allocation a
             WHERE a.request_item_id = p_item_id
               AND a.status <> 'CANCELLED');
END $$

-- Status of an item that isn't CANCELLED, from what's requested and allocated.
DROP FUNCTION IF EXISTS fn_item_status_for $$
CREATE FUNCTION fn_item_status_for(p_requested DECIMAL(12,2), p_allocated DECIMAL(12,2))
RETURNS VARCHAR(30)
DETERMINISTIC
NO SQL
SQL SECURITY INVOKER
COMMENT 'PENDING (nothing allocated), PARTIAL, or FULFILLED'
BEGIN
    RETURN CASE
        WHEN p_allocated <= 0           THEN 'PENDING'
        WHEN p_allocated >= p_requested THEN 'FULFILLED'
        ELSE 'PARTIAL'
    END;
END $$

-- Request status rolled up from its items.
DROP FUNCTION IF EXISTS fn_request_status $$
CREATE FUNCTION fn_request_status(p_request_id INT)
RETURNS VARCHAR(30)
NOT DETERMINISTIC
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'OPEN, PARTIALLY_FULFILLED, FULFILLED or CANCELLED from the items'
BEGIN
    DECLARE v_total, v_cancelled, v_fulfilled, v_partial INT;
    SELECT COUNT(*),
           COALESCE(SUM(status = 'CANCELLED'), 0),
           COALESCE(SUM(status = 'FULFILLED'), 0),
           COALESCE(SUM(status = 'PARTIAL'), 0)
      INTO v_total, v_cancelled, v_fulfilled, v_partial
      FROM request_item
     WHERE request_id = p_request_id;
    RETURN CASE
        WHEN v_total = 0                          THEN 'OPEN'
        WHEN v_cancelled = v_total                THEN 'CANCELLED'
        WHEN v_fulfilled = v_total - v_cancelled  THEN 'FULFILLED'
        WHEN v_fulfilled + v_partial > 0          THEN 'PARTIALLY_FULFILLED'
        ELSE 'OPEN'
    END;
END $$

-- Move an item's quantity_allocated by p_delta. Called only by the allocation
-- triggers, which already hold the item's lock. @item_alloc_sync tells
-- trg_item_bu that this change is theirs (hand edits are refused); it is
-- restored afterwards, even on error. trg_item_bu then derives the status.
DROP PROCEDURE IF EXISTS sp_add_item_allocated $$
CREATE PROCEDURE sp_add_item_allocated(IN p_item_id INT, IN p_delta DECIMAL(12,2))
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'Trigger helper: change request_item.quantity_allocated'
BEGIN
    DECLARE v_prev_sync INT DEFAULT @item_alloc_sync;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET @item_alloc_sync = v_prev_sync;
        RESIGNAL;
    END;

    SET @item_alloc_sync = p_item_id;
    UPDATE request_item SET quantity_allocated = quantity_allocated + p_delta
     WHERE request_item_id = p_item_id;
    SET @item_alloc_sync = v_prev_sync;
END $$

-- Rewrite a request's status from its items. Called by the item triggers,
-- which already hold the request's lock.
DROP PROCEDURE IF EXISTS sp_sync_request_status $$
CREATE PROCEDURE sp_sync_request_status(IN p_request_id INT)
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'Trigger helper: recompute resource_request.status'
BEGIN
    DECLARE v_new VARCHAR(30) DEFAULT fn_request_status(p_request_id);
    UPDATE resource_request SET status = v_new
     WHERE request_id = p_request_id AND status <> v_new;
END $$

-- ===========================================================================
-- allocation
-- ===========================================================================

-- Invariants 2 and 3 (new rows). Stock sufficiency is checked by trg_stock_bu
-- when trg_allocation_ai takes the stock.
DROP TRIGGER IF EXISTS trg_allocation_bi $$
CREATE TRIGGER trg_allocation_bi BEFORE INSERT ON allocation
FOR EACH ROW
BEGIN
    DECLARE v_item_status, v_center_status, v_emergency_status VARCHAR(30);
    DECLARE v_requested, v_allocated DECIMAL(12,2);
    DECLARE v_item_resource, v_stock_resource, v_request_id, v_impact_id, v_center_id INT;
    DECLARE v_center_name VARCHAR(100);
    DECLARE v_expiry DATE;

    -- Locks first: item -> request -> stock, then center and emergency shared.
    SELECT status, quantity_requested, quantity_allocated, resource_id, request_id
      INTO v_item_status, v_requested, v_allocated, v_item_resource, v_request_id
      FROM request_item WHERE request_item_id = NEW.request_item_id FOR UPDATE;
    IF v_item_status IS NULL THEN
        CALL sp_raise(CONCAT_WS(' ', 'Request item', NEW.request_item_id, 'not found'));
    END IF;
    SELECT impact_id INTO v_impact_id
      FROM resource_request WHERE request_id = v_request_id FOR UPDATE;
    SELECT resource_id, expiry_date, center_id
      INTO v_stock_resource, v_expiry, v_center_id
      FROM stock WHERE stock_id = NEW.stock_id FOR UPDATE;
    IF v_stock_resource IS NULL THEN
        CALL sp_raise(CONCAT_WS(' ', 'Batch', NEW.stock_id, 'not found'));
    END IF;
    SELECT name, status INTO v_center_name, v_center_status
      FROM resource_center WHERE center_id = v_center_id FOR SHARE;
    SELECT e.status INTO v_emergency_status
      FROM emergency_impact ei
      JOIN emergency e ON e.emergency_id = ei.emergency_id
     WHERE ei.impact_id = v_impact_id
       FOR SHARE OF e;

    IF NOT (NEW.status <=> 'RESERVED') THEN
        CALL sp_raise('New allocations start RESERVED');
    END IF;
    IF NOT (NEW.quantity_allocated > 0) THEN
        CALL sp_raise('Quantity to allocate must be greater than 0');
    END IF;
    IF v_item_status NOT IN ('PENDING', 'PARTIAL') THEN
        CALL sp_raise(CONCAT('Item is ', v_item_status, '; only PENDING or PARTIAL items can be allocated'));
    END IF;
    IF v_emergency_status = 'CLOSED' THEN
        CALL sp_raise('Emergency is CLOSED');
    END IF;
    IF v_center_status = 'CLOSED' THEN
        CALL sp_raise(CONCAT('Center ', v_center_name, ' is CLOSED'));
    END IF;
    IF v_stock_resource <> v_item_resource THEN
        CALL sp_raise('Batch holds a different resource than the item');
    END IF;
    IF v_expiry < CURDATE() THEN
        CALL sp_raise(CONCAT('Batch expired on ', v_expiry));
    END IF;

    IF v_allocated + NEW.quantity_allocated > v_requested THEN
        CALL sp_raise(CONCAT('Only ', v_requested - v_allocated, ' left to allocate for this item'));
    END IF;
END $$

-- Invariant 4 (take the stock) and 5 (recompute the item).
DROP TRIGGER IF EXISTS trg_allocation_ai $$
CREATE TRIGGER trg_allocation_ai AFTER INSERT ON allocation
FOR EACH ROW
BEGIN
    DECLARE v_rows INT;
    CALL sp_change_stock(NEW.stock_id, -NEW.quantity_allocated, 'ALLOCATION',
                         NEW.allocation_id, NEW.user_id, v_rows);
    CALL sp_add_item_allocated(NEW.request_item_id, NEW.quantity_allocated);
END $$

-- Invariant 3: fixed columns and allowed transitions. Every UPDATE of an
-- allocation must be a status transition.
DROP TRIGGER IF EXISTS trg_allocation_bu $$
CREATE TRIGGER trg_allocation_bu BEFORE UPDATE ON allocation
FOR EACH ROW
BEGIN
    IF NOT (NEW.request_item_id <=> OLD.request_item_id) THEN
        CALL sp_raise('Allocation request_item_id can''t change');
    END IF;
    IF NOT (NEW.stock_id <=> OLD.stock_id) THEN
        CALL sp_raise('Allocation stock_id can''t change');
    END IF;
    IF NOT (NEW.user_id <=> OLD.user_id) THEN
        CALL sp_raise('Allocation user_id can''t change');
    END IF;
    IF NOT (NEW.quantity_allocated <=> OLD.quantity_allocated) THEN
        CALL sp_raise('Allocation quantity_allocated can''t change');
    END IF;
    IF NOT (NEW.allocated_at <=> OLD.allocated_at) THEN
        CALL sp_raise('Allocation allocated_at can''t change');
    END IF;
    IF NEW.status <=> OLD.status THEN
        CALL sp_raise(CONCAT('Allocation is already ', OLD.status));
    END IF;
    IF NOT (   (OLD.status = 'RESERVED'   AND NEW.status IN ('DISPATCHED', 'CANCELLED'))
            OR (OLD.status = 'DISPATCHED' AND NEW.status IN ('DELIVERED', 'CANCELLED'))) THEN
        CALL sp_raise(CONCAT_WS(' ', 'Allocation can''t go from', OLD.status, 'to', NEW.status));
    END IF;
END $$

-- Invariant 4 (return the stock) and 5 (recompute the item), on cancel only:
-- DISPATCHED and DELIVERED don't change what's allocated.
DROP TRIGGER IF EXISTS trg_allocation_au $$
CREATE TRIGGER trg_allocation_au AFTER UPDATE ON allocation
FOR EACH ROW
BEGIN
    DECLARE v_request_id, v_rows INT;

    IF NEW.status = 'CANCELLED' THEN
        -- The UPDATE holds the allocation row; now item -> request (-> stock below).
        SELECT request_id INTO v_request_id
          FROM request_item WHERE request_item_id = NEW.request_item_id FOR UPDATE;
        SELECT request_id INTO v_request_id
          FROM resource_request WHERE request_id = v_request_id FOR UPDATE;

        -- changed_by is whoever cancelled (@ledger_user, set by sp_cancel_allocation).
        CALL sp_change_stock(NEW.stock_id, NEW.quantity_allocated, 'ALLOCATION_CANCELLED',
                             NEW.allocation_id, @ledger_user, v_rows);
        CALL sp_add_item_allocated(NEW.request_item_id, -NEW.quantity_allocated);
    END IF;
END $$

-- ===========================================================================
-- stock
-- ===========================================================================

-- Invariant 1 with a readable message, and a batch's identity once allocated.
-- (An INSERT with a negative quantity still fails on chk_stock_quantity, 3819.)
DROP TRIGGER IF EXISTS trg_stock_bu $$
CREATE TRIGGER trg_stock_bu BEFORE UPDATE ON stock
FOR EACH ROW
BEGIN
    IF NEW.quantity_available < 0 THEN
        CALL sp_raise('Insufficient stock in this batch');
    END IF;
    -- Reads allocations only when the identity really changes, so the quantity
    -- updates on the allocate and cancel paths never do.
    IF NOT (NEW.resource_id <=> OLD.resource_id) OR NOT (NEW.center_id <=> OLD.center_id) THEN
        IF EXISTS (SELECT 1 FROM allocation WHERE stock_id = OLD.stock_id) THEN
            CALL sp_raise('A batch''s resource and center can''t change once it has allocations');
        END IF;
    END IF;
END $$

-- Invariant 1: a new batch with stock logs a RECEIPT.
DROP TRIGGER IF EXISTS trg_stock_ai $$
CREATE TRIGGER trg_stock_ai AFTER INSERT ON stock
FOR EACH ROW
BEGIN
    IF NEW.quantity_available > 0 THEN
        INSERT INTO stock_ledger (stock_id, change_qty, balance_after, reason, changed_by)
        VALUES (NEW.stock_id, NEW.quantity_available, NEW.quantity_available, 'RECEIPT', @ledger_user);
    END IF;
END $$

-- Invariant 1: every quantity change logs one row. The reason, allocation and
-- user come from sp_change_stock (05_procedures.sql); without them (a console
-- UPDATE) the reason is ADJUSTMENT and changed_by is NULL.
DROP TRIGGER IF EXISTS trg_stock_au $$
CREATE TRIGGER trg_stock_au AFTER UPDATE ON stock
FOR EACH ROW
BEGIN
    IF NEW.quantity_available <> OLD.quantity_available THEN
        INSERT INTO stock_ledger (stock_id, change_qty, balance_after, reason, allocation_id, changed_by)
        VALUES (NEW.stock_id,
                NEW.quantity_available - OLD.quantity_available,
                NEW.quantity_available,
                COALESCE(@ledger_reason, 'ADJUSTMENT'),
                @ledger_alloc,
                @ledger_user);
    END IF;
END $$

-- ===========================================================================
-- request_item
-- ===========================================================================

-- Invariant 5: new items start PENDING.
DROP TRIGGER IF EXISTS trg_item_bi $$
CREATE TRIGGER trg_item_bi BEFORE INSERT ON request_item
FOR EACH ROW
BEGIN
    DECLARE v_request_id INT;
    SELECT request_id INTO v_request_id
      FROM resource_request WHERE request_id = NEW.request_id FOR UPDATE;
    IF NOT (NEW.status <=> 'PENDING') THEN
        CALL sp_raise('New items start PENDING');
    END IF;
    IF NOT (NEW.quantity_allocated <=> 0) THEN
        CALL sp_raise('New items start with nothing allocated');
    END IF;
END $$

-- Invariant 6.
DROP TRIGGER IF EXISTS trg_item_ai $$
CREATE TRIGGER trg_item_ai AFTER INSERT ON request_item
FOR EACH ROW
BEGIN
    CALL sp_sync_request_status(NEW.request_id);
END $$

-- Invariant 5: guards on every item change.
DROP TRIGGER IF EXISTS trg_item_bu $$
CREATE TRIGGER trg_item_bu BEFORE UPDATE ON request_item
FOR EACH ROW
BEGIN
    DECLARE v_request_id INT;
    DECLARE v_allocated DECIMAL(12,2);
    DECLARE v_derived VARCHAR(30);

    -- The UPDATE already holds this item's lock; take the request's before any plain read.
    SELECT request_id INTO v_request_id
      FROM resource_request WHERE request_id = OLD.request_id FOR UPDATE;

    IF NOT (NEW.request_id <=> OLD.request_id) THEN
        CALL sp_raise('An item can''t move to another request');
    END IF;
    -- quantity_allocated changes only through sp_add_item_allocated (the
    -- allocation triggers). Checked with a flag, not by summing allocations,
    -- which would take shared locks on them (see Locking above).
    IF NOT (NEW.quantity_allocated <=> OLD.quantity_allocated)
       AND NOT (@item_alloc_sync <=> OLD.request_item_id) THEN
        CALL sp_raise('quantity_allocated is kept by the allocation triggers');
    END IF;
    -- Reads allocations only when the resource really changes (never on the
    -- allocate or cancel paths).
    IF NOT (NEW.resource_id <=> OLD.resource_id) THEN
        IF EXISTS (SELECT 1 FROM allocation WHERE request_item_id = OLD.request_item_id) THEN
            CALL sp_raise('An item''s resource can''t change once it has allocations');
        END IF;
    END IF;

    SET v_allocated = NEW.quantity_allocated;
    IF NEW.quantity_requested < v_allocated THEN
        CALL sp_raise(CONCAT('Requested quantity can''t go below the ', v_allocated, ' already allocated'));
    END IF;

    IF OLD.status = 'CANCELLED' THEN
        -- Stays CANCELLED, including when only the quantity is edited.
        IF NOT (NEW.status <=> 'CANCELLED') THEN
            CALL sp_raise('A cancelled item can''t be reopened');
        END IF;
    ELSEIF NEW.status = 'CANCELLED' THEN
        IF v_allocated > 0 THEN
            CALL sp_raise('Cancel this item''s allocations first');
        END IF;
    ELSE
        SET v_derived = fn_item_status_for(NEW.quantity_requested, v_allocated);
        IF NEW.status <=> OLD.status THEN
            -- Status not being changed (e.g. a quantity edit): follow the allocations.
            SET NEW.status = v_derived;
        ELSEIF NOT (NEW.status <=> v_derived) THEN
            CALL sp_raise(CONCAT('Item status follows its allocations (would be ', v_derived, ')'));
        END IF;
    END IF;
END $$

-- Invariant 6.
DROP TRIGGER IF EXISTS trg_item_au $$
CREATE TRIGGER trg_item_au AFTER UPDATE ON request_item
FOR EACH ROW
BEGIN
    IF NOT (NEW.status <=> OLD.status) THEN
        CALL sp_sync_request_status(NEW.request_id);
    END IF;
END $$

-- Invariant 6.
DROP TRIGGER IF EXISTS trg_item_ad $$
CREATE TRIGGER trg_item_ad AFTER DELETE ON request_item
FOR EACH ROW
BEGIN
    CALL sp_sync_request_status(OLD.request_id);
END $$

-- ===========================================================================
-- resource_request
-- ===========================================================================

-- Invariant 6: new requests start OPEN.
DROP TRIGGER IF EXISTS trg_request_bi $$
CREATE TRIGGER trg_request_bi BEFORE INSERT ON resource_request
FOR EACH ROW
BEGIN
    IF NOT (NEW.status <=> 'OPEN') THEN
        CALL sp_raise('New requests start OPEN');
    END IF;
END $$

-- Invariant 6: a status written by hand must match the rollup.
DROP TRIGGER IF EXISTS trg_request_bu $$
CREATE TRIGGER trg_request_bu BEFORE UPDATE ON resource_request
FOR EACH ROW
BEGIN
    DECLARE v_rollup VARCHAR(30);
    IF NOT (NEW.status <=> OLD.status) THEN
        SET v_rollup = fn_request_status(NEW.request_id);
        IF NOT (NEW.status <=> v_rollup) THEN
            CALL sp_raise(CONCAT('Request status follows its items (would be ', v_rollup, ')'));
        END IF;
    END IF;
END $$

DELIMITER ;
