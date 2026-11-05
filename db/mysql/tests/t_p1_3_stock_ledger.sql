-- t_p1_3_stock_ledger.sql — P1.3 stock and ledger: sp_add_batch, sp_adjust_stock,
-- the stock triggers, the stock_ledger CHECKs and T18 reconciliation
-- (02_alter.sql, 05_procedures.sql, 06_triggers.sql). Run with: npm run db:test
--
-- Runs as the app user (MYSQL_USER), so it also proves the app's privileges.
-- Safe on an empty or a seeded database:
--   * the fixture only adds rows: roles are looked up by name and inserted only
--     if missing; every UNIQUE value starts with zz_t13_
--   * every assertion is limited to the fixture's own ids
--   * the fixture is rolled back, and row counts are checked before and after
--
-- Each check appends [section, check, expected, actual, ok] to @results, a JSON
-- array in a user variable (the app user can't create temporary tables). The file
-- ends by printing one row per check (PASS/FAIL) and a summary row.
--
-- Check pattern:
--   SET @c = '<check>', @e = <expected>, @a = <actual>;
--   SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
-- The second line is repeated on purpose. Don't turn it into a PREPAREd statement:
-- MySQL fixes user-variable types at PREPARE time, so @a <=> @e would compare
-- every check as the first check's type (e.g. 'abc' <=> 'abd' is true as DECIMAL).
--
-- The setup and report blocks are the same in every t_p1_* file, so each file
-- runs on its own (mysql CLI, Workbench). Keep the copies identical.

SET @results = JSON_ARRAY();

-- Row counts of every table, as one string. Prepared once, run before and after
-- the rolled-back fixture. (Safe to prepare: it reads no user variables, whose
-- types MySQL would fix at PREPARE time.)
PREPARE snapshot_counts FROM 'SET @counts = CONCAT_WS('','',
    (SELECT COUNT(*) FROM role), (SELECT COUNT(*) FROM `user`), (SELECT COUNT(*) FROM location),
    (SELECT COUNT(*) FROM emergency), (SELECT COUNT(*) FROM emergency_impact),
    (SELECT COUNT(*) FROM impact_observation), (SELECT COUNT(*) FROM resource),
    (SELECT COUNT(*) FROM resource_center), (SELECT COUNT(*) FROM stock),
    (SELECT COUNT(*) FROM stock_ledger), (SELECT COUNT(*) FROM resource_request),
    (SELECT COUNT(*) FROM request_item), (SELECT COUNT(*) FROM allocation))';

-- ===========================================================================
-- P1.3 stock and ledger, on a rolled-back fixture
-- ===========================================================================
-- Expected errors go through sp_test_expect (08_test_support.sql) and are
-- compared as '<errno>: <message>'; 1644 is a SIGNAL '45000' from our rules.
SET @section = 'P1.3 stock';
EXECUTE snapshot_counts;
SET @counts_before = @counts;

START TRANSACTION;
SET @now = NOW();

-- People
INSERT INTO role (role_name)
SELECT 'COORDINATOR' FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM role WHERE role_name = 'COORDINATOR');
SET @role = (SELECT role_id FROM role WHERE role_name = 'COORDINATOR');
INSERT INTO `user` (role_id, name, email, password_hash)
VALUES (@role, 'zz_t13 allocator', 'zz_t13_alloc@eras.test', 'not-a-real-hash');
SET @u1 = LAST_INSERT_ID();
INSERT INTO `user` (role_id, name, email, password_hash)
VALUES (@role, 'zz_t13 manager', 'zz_t13_mgr@eras.test', 'not-a-real-hash');
SET @u2 = LAST_INSERT_ID();

-- Places: the impact in Bengaluru; a center about 1 km (near) and 73 km (far) away.
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t13_g_impact', 12.9716000, 77.5946000);
SET @loc_imp = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t13_g_near', 12.9800000, 77.6000000);
SET @loc_near = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t13_g_far', 13.5000000, 78.0000000);
SET @loc_far = LAST_INSERT_ID();

INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@loc_near, 'zz_t13 near warehouse', 'WAREHOUSE', 'OPERATIONAL');
SET @c_near = LAST_INSERT_ID();
INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@loc_far, 'zz_t13 far hospital', 'HOSPITAL', 'OPERATIONAL');
SET @c_far = LAST_INSERT_ID();

INSERT INTO emergency (name, type, start_time, status)
VALUES ('zz_t13 active flood', 'FLOOD', @now - INTERVAL 2 DAY, 'ACTIVE');
SET @em = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@em, @loc_imp, 'ACTIVE');
SET @imp = LAST_INSERT_ID();

INSERT INTO resource (name, category, unit) VALUES ('zz_t13 water', 'WATER', 'L');
SET @r_water = LAST_INSERT_ID();

-- Batches. Two go through sp_add_batch (RECEIPT by @u2; a zero batch logs nothing).
CALL sp_add_batch(@r_water, @c_near, 'zz_t13_W_NEAR', 100, CURDATE() + INTERVAL 30 DAY, @u2, @b_near);
CALL sp_add_batch(@r_water, @c_near, 'zz_t13_W_EMPTY', 0, CURDATE() + INTERVAL 30 DAY, @u2, @b_empty);
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
VALUES (@r_water, @c_far, 'zz_t13_W_FAR', 200, CURDATE() + INTERVAL 5 DAY);
SET @b_far = LAST_INSERT_ID();

-- One request item, so the batches can have allocations.
INSERT INTO resource_request (impact_id, user_id, requested_at) VALUES (@imp, @u1, @now - INTERVAL 2 HOUR);
SET @req1 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req1, @r_water, 150, 'HIGH');
SET @i_water = LAST_INSERT_ID();

-- ---- Appendix A: constraints ----
CALL sp_test_expect(CONCAT('INSERT INTO stock (resource_id, center_id, batch_code, quantity_available) VALUES (',
                           @r_water, ', ', @c_near, ', ''zz_t13_NEG'', -5)'), @errno, @msg);
SET @c = 'T01 stock with quantity -5', @e = '3819: Check constraint ''chk_stock_quantity'' is violated.',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ---- receipts ----
SET @c = 'sp_add_batch: RECEIPT by the user (reason/change/balance/by)', @e = 'RECEIPT/100.00/100.00/1',
    @a = (SELECT CONCAT_WS('/', reason, change_qty, balance_after, changed_by <=> @u2)
            FROM stock_ledger WHERE stock_id = @b_near);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'a zero-quantity batch logs nothing', @e = 0,
    @a = (SELECT COUNT(*) FROM stock_ledger WHERE stock_id = @b_empty);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- Fixture steps (not checks): @b_near is allocated, so it can't move center;
-- @b_far is allocated and cancelled (back to 200), so its ledger holds
-- ALLOCATION and ALLOCATION_CANCELLED rows for T18.
CALL sp_allocate(@i_water, @b_near, 100, @u1, @a1);
CALL sp_allocate(@i_water, @b_far, 30, @u1, @a_far);
CALL sp_cancel_allocation(@a_far, @u2);

-- ---- stock ----
SET @n = (SELECT COUNT(*) FROM stock_ledger WHERE stock_id = @b_far);
UPDATE stock SET quantity_available = quantity_available WHERE stock_id = @b_far;
SET @c = 'a zero-change UPDATE writes no ledger row', @e = @n,
    @a = (SELECT COUNT(*) FROM stock_ledger WHERE stock_id = @b_far);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

UPDATE stock SET quantity_available = quantity_available + 5 WHERE stock_id = @b_far;
SET @c = 'T10 console UPDATE (reason/change/balance/alloc/by)', @e = 'ADJUSTMENT/5.00/205.00/NULL/NULL',
    @a = (SELECT CONCAT_WS('/', reason, change_qty, balance_after,
                           COALESCE(allocation_id, 'NULL'), COALESCE(changed_by, 'NULL'))
            FROM stock_ledger WHERE stock_id = @b_far ORDER BY ledger_id DESC LIMIT 1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_adjust_stock(@b_far, -5, 'WRITE_OFF', @u2);
SET @c = 'sp_adjust_stock WRITE_OFF (reason/change/balance/by)', @e = 'WRITE_OFF/-5.00/200.00/1',
    @a = (SELECT CONCAT_WS('/', reason, change_qty, balance_after, changed_by <=> @u2)
            FROM stock_ledger WHERE stock_id = @b_far ORDER BY ledger_id DESC LIMIT 1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'ledger variables clear after an adjustment', @e = '-/-/-',
    @a = CONCAT_WS('/', COALESCE(@ledger_reason, '-'), COALESCE(@ledger_alloc, '-'), COALESCE(@ledger_user, '-'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_adjust_stock(', @b_far, ', 5, ''RECEIPT'', ', @u2, ')'), @errno, @msg);
SET @c = 'adjust with reason RECEIPT', @e = '1644: Reason must be ADJUSTMENT or WRITE_OFF',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('CALL sp_adjust_stock(', @b_far, ', 5, ''adjustment'', ', @u2, ')'), @errno, @msg);
SET @c = 'adjust with reason adjustment (lowercase)', @e = '1644: Reason must be ADJUSTMENT or WRITE_OFF',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('CALL sp_adjust_stock(', @b_far, ', 0, ''ADJUSTMENT'', ', @u2, ')'), @errno, @msg);
SET @c = 'adjust by 0', @e = '1644: Adjustment must change the quantity',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('CALL sp_adjust_stock(', @b_far, ', 5, ''WRITE_OFF'', ', @u2, ')'), @errno, @msg);
SET @c = 'write off a positive amount', @e = '1644: A write-off must reduce the quantity',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('CALL sp_adjust_stock(', @b_far, ', -1000, ''ADJUSTMENT'', ', @u2, ')'), @errno, @msg);
SET @c = 'adjust below zero', @e = '1644: Insufficient stock in this batch',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'ledger variables clear after a failed adjustment', @e = '-/-/-',
    @a = CONCAT_WS('/', COALESCE(@ledger_reason, '-'), COALESCE(@ledger_alloc, '-'), COALESCE(@ledger_user, '-'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('CALL sp_adjust_stock(-1, 5, ''ADJUSTMENT'', ', @u2, ')'), @errno, @msg);
SET @c = 'adjust a missing batch', @e = '1644: Batch -1 not found',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('UPDATE stock SET quantity_available = -1 WHERE stock_id = ', @b_far), @errno, @msg);
SET @c = 'console UPDATE below zero', @e = '1644: Insufficient stock in this batch',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE stock SET center_id = ', @c_far, ' WHERE stock_id = ', @b_near), @errno, @msg);
SET @c = 'move an allocated batch to another center', @e = '1644: A batch''s resource and center can''t change once it has allocations',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ---- T18: the ledger agrees with the stock, for every fixture batch ----
SET @c = 'T18 running SUM(change_qty) <> balance_after (rows)', @e = 0,
    @a = (SELECT COUNT(*)
            FROM (SELECT l.balance_after,
                         SUM(l.change_qty) OVER (PARTITION BY l.stock_id ORDER BY l.changed_at, l.ledger_id) AS running
                    FROM stock_ledger l
                    JOIN stock s ON s.stock_id = l.stock_id
                   WHERE s.center_id IN (@c_near, @c_far)) AS x
           WHERE x.running <> x.balance_after);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'T18 last balance <> quantity_available (batches)', @e = 0,
    @a = (SELECT COUNT(*)
            FROM stock s
           WHERE s.center_id IN (@c_near, @c_far)
             AND s.quantity_available <> COALESCE((SELECT l.balance_after FROM stock_ledger l
                                                    WHERE l.stock_id = s.stock_id
                                                    ORDER BY l.changed_at DESC, l.ledger_id DESC LIMIT 1), 0));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

ROLLBACK;

EXECUTE snapshot_counts;
DEALLOCATE PREPARE snapshot_counts;
SET @c = 'row counts unchanged after ROLLBACK', @e = @counts_before, @a = @counts;
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ===========================================================================
-- Report (same block in every t_p1_* file)
-- ===========================================================================
SET @failures = (
    SELECT COUNT(*)
      FROM JSON_TABLE(@results, '$[*]' COLUMNS (ok BOOLEAN PATH '$[4]')) AS jt
     WHERE NOT jt.ok);

SELECT jt.n, jt.section, jt.check_name, jt.expected, jt.actual,
       IF(jt.ok, 'PASS', 'FAIL') AS result
  FROM JSON_TABLE(@results, '$[*]' COLUMNS (
           n          FOR ORDINALITY,
           section    VARCHAR(20)  PATH '$[0]',
           check_name VARCHAR(80)  PATH '$[1]',
           expected   VARCHAR(160) PATH '$[2]',
           actual     VARCHAR(160) PATH '$[3]',
           ok         BOOLEAN      PATH '$[4]')) AS jt;

SELECT 't_p1_3_stock_ledger' AS file, JSON_LENGTH(@results) AS checks, @failures AS failures,
       IF(@failures = 0, 'PASS', 'FAIL') AS result;
