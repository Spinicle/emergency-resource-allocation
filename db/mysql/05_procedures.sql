-- 05_procedures.sql
-- Entry points for allocation and stock (docs/HANDOFF.md 4.4).
--
-- Each procedure runs exactly ONE write statement. The triggers in
-- 06_triggers.sql take the locks, check the rules (with readable SIGNAL '45000'
-- messages) and do the side effects inside that statement. A statement is
-- atomic with its triggers: if anything fails, all of it is undone and the
-- caller's transaction is left as it was. So no procedure starts, commits or
-- rolls back a transaction, and they are safe to CALL inside one.
--
-- Caller rule for sp_allocate: call it in autocommit, or as the first statement
-- of a transaction, one item per transaction (see HANDOFF 4.4).
--
-- The ledger session variables (@ledger_reason, @ledger_alloc, @ledger_user) are
-- set only here: sp_change_stock sets all three around its UPDATE and restores
-- them; sp_cancel_allocation and sp_add_batch set @ledger_user (who did it) and
-- clear it. All of them undo their changes in error handlers too, because
-- pooled connections are reused.
--
-- All procedures run with the caller's privileges (SQL SECURITY INVOKER).

DELIMITER $$

-- ---------------------------------------------------------------------------
-- sp_raise: SIGNAL SQLSTATE '45000' with a computed message. (SIGNAL itself
-- only accepts a literal or a variable.) Used by the procedures and triggers.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_raise $$
CREATE PROCEDURE sp_raise(IN p_message VARCHAR(255))
NO SQL
SQL SECURITY INVOKER
COMMENT 'SIGNAL 45000 with this message (max 128 characters)'
BEGIN
    DECLARE v_message VARCHAR(128) DEFAULT LEFT(COALESCE(p_message, 'Error'), 128);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_message;
END $$

-- ---------------------------------------------------------------------------
-- sp_allocate: reserve p_qty of batch p_stock for request item p_item.
-- One INSERT; trg_allocation_bi checks it, trg_allocation_ai takes the stock,
-- writes the ALLOCATION ledger row and updates the item and request statuses.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_allocate $$
CREATE PROCEDURE sp_allocate(
    IN  p_item          INT,
    IN  p_stock         INT,
    IN  p_qty           DECIMAL(12,2),
    IN  p_user          INT,
    OUT p_allocation_id INT
)
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'Reserve stock from one batch for one request item'
BEGIN
    INSERT INTO allocation (request_item_id, stock_id, user_id, quantity_allocated)
    VALUES (p_item, p_stock, p_user, p_qty);
    -- Triggers' own inserts (ledger rows) don't change LAST_INSERT_ID() here.
    SET p_allocation_id = LAST_INSERT_ID();
END $$

-- ---------------------------------------------------------------------------
-- sp_cancel_allocation: cancel an allocation and return its stock.
-- One UPDATE; trg_allocation_bu checks the transition, trg_allocation_au returns
-- the stock (ledger ALLOCATION_CANCELLED, changed_by = p_user) and recomputes
-- the item and request statuses.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_cancel_allocation $$
CREATE PROCEDURE sp_cancel_allocation(IN p_allocation_id INT, IN p_user INT)
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'Cancel an allocation and return its quantity to the batch'
BEGIN
    DECLARE v_rows INT;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET @ledger_user = NULL;
        RESIGNAL;
    END;

    SET @ledger_user = p_user;
    UPDATE allocation SET status = 'CANCELLED' WHERE allocation_id = p_allocation_id;
    SET v_rows = ROW_COUNT();
    SET @ledger_user = NULL;
    -- The trigger refuses a same-status update, so 0 rows only means "no such id".
    IF v_rows = 0 THEN
        CALL sp_raise(CONCAT_WS(' ', 'Allocation', p_allocation_id, 'not found'));
    END IF;
END $$

-- ---------------------------------------------------------------------------
-- sp_suggest_batches: usable batches for one item, best first, with a
-- suggested split (v_batch_suggestions). Empty if the item isn't open.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_suggest_batches $$
CREATE PROCEDURE sp_suggest_batches(IN p_item INT)
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'Usable batches for an item: nearest first, then earliest expiry'
BEGIN
    IF NOT EXISTS (SELECT 1 FROM request_item WHERE request_item_id = p_item) THEN
        CALL sp_raise(CONCAT_WS(' ', 'Request item', p_item, 'not found'));
    END IF;
    SELECT stock_id, batch_code, center_id, center_name, center_status, quantity_available,
           expiry_date, days_left, distance_km, suggestion_rank, suggested_qty
      FROM v_batch_suggestions
     WHERE request_item_id = p_item
     ORDER BY suggestion_rank;
END $$

-- ---------------------------------------------------------------------------
-- sp_add_batch: receive a new batch. One INSERT; trg_stock_ai writes the
-- RECEIPT ledger row (changed_by = p_user) when the quantity is above 0.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_add_batch $$
CREATE PROCEDURE sp_add_batch(
    IN  p_resource   INT,
    IN  p_center     INT,
    IN  p_batch_code VARCHAR(50),
    IN  p_qty        DECIMAL(12,2),
    IN  p_expiry     DATE,
    IN  p_user       INT,
    OUT p_stock_id   INT
)
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'Receive a new stock batch (ledger RECEIPT)'
BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET @ledger_user = NULL;
        RESIGNAL;
    END;

    SET @ledger_user = p_user;
    INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
    VALUES (p_resource, p_center, p_batch_code, p_qty, p_expiry);
    SET p_stock_id = LAST_INSERT_ID();
    SET @ledger_user = NULL;
END $$

-- ---------------------------------------------------------------------------
-- sp_change_stock: the one place a batch's quantity changes with a ledger
-- reason, allocation and user. It sets @ledger_reason / @ledger_alloc /
-- @ledger_user for trg_stock_au, runs one UPDATE by p_delta, and restores the
-- variables afterwards, even on error. p_rows is 0 if the batch doesn't exist.
-- Used by sp_adjust_stock and the allocation triggers.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_change_stock $$
CREATE PROCEDURE sp_change_stock(
    IN  p_stock      INT,
    IN  p_delta      DECIMAL(12,2),
    IN  p_reason     VARCHAR(30),
    IN  p_allocation INT,
    IN  p_user       INT,
    OUT p_rows       INT
)
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'Change a batch quantity with a ledger reason, allocation and user'
BEGIN
    DECLARE v_prev_reason VARCHAR(30) DEFAULT @ledger_reason;
    DECLARE v_prev_alloc INT DEFAULT @ledger_alloc;
    DECLARE v_prev_user INT DEFAULT @ledger_user;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET @ledger_reason = v_prev_reason, @ledger_alloc = v_prev_alloc, @ledger_user = v_prev_user;
        RESIGNAL;
    END;

    SET @ledger_reason = p_reason, @ledger_alloc = p_allocation, @ledger_user = p_user;
    UPDATE stock SET quantity_available = quantity_available + p_delta WHERE stock_id = p_stock;
    SET p_rows = ROW_COUNT();
    SET @ledger_reason = v_prev_reason, @ledger_alloc = v_prev_alloc, @ledger_user = v_prev_user;
END $$

-- ---------------------------------------------------------------------------
-- sp_adjust_stock: correct a batch by p_delta (ADJUSTMENT) or write stock off
-- (WRITE_OFF, which must reduce it). One UPDATE (through sp_change_stock);
-- trg_stock_bu refuses a negative result, trg_stock_au writes the ledger row.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_adjust_stock $$
CREATE PROCEDURE sp_adjust_stock(
    IN p_stock  INT,
    IN p_delta  DECIMAL(12,2),
    IN p_reason VARCHAR(30),
    IN p_user   INT
)
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'Adjust or write off a batch (ledger ADJUSTMENT / WRITE_OFF)'
BEGIN
    DECLARE v_rows INT;

    IF p_reason IS NULL OR p_reason NOT IN ('ADJUSTMENT', 'WRITE_OFF') THEN
        CALL sp_raise('Reason must be ADJUSTMENT or WRITE_OFF');
    END IF;
    IF p_delta IS NULL OR p_delta = 0 THEN
        CALL sp_raise('Adjustment must change the quantity');
    END IF;
    IF p_reason = 'WRITE_OFF' AND p_delta > 0 THEN
        CALL sp_raise('A write-off must reduce the quantity');
    END IF;

    CALL sp_change_stock(p_stock, p_delta, p_reason, NULL, p_user, v_rows);
    IF v_rows = 0 THEN
        CALL sp_raise(CONCAT_WS(' ', 'Batch', p_stock, 'not found'));
    END IF;
END $$

DELIMITER ;
