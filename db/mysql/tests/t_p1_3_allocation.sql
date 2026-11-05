-- t_p1_3_allocation.sql — P1.3 allocation: sp_allocate, sp_cancel_allocation,
-- sp_suggest_batches, v_batch_suggestions and the allocation triggers
-- (05_procedures.sql, 06_triggers.sql). Run with: npm run db:test
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
-- P1.3 allocation, on a rolled-back fixture
-- ===========================================================================
-- Expected errors go through sp_test_expect (08_test_support.sql) and are
-- compared as '<errno>: <message>'; 1644 is a SIGNAL '45000' from our rules.
SET @section = 'P1.3 allocation';
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

-- Places: the impact in Bengaluru; centers about 1 km (near), 14 km (LIMITED)
-- and 73 km (far) away, and a CLOSED one closest of all.
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t13_g_impact', 12.9716000, 77.5946000);
SET @loc_imp = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t13_g_closed_impact', 12.4244000, 75.7382000);
SET @loc_imp_closed = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t13_g_near', 12.9800000, 77.6000000);
SET @loc_near = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t13_g_ltd', 13.1000000, 77.6000000);
SET @loc_ltd = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t13_g_far', 13.5000000, 78.0000000);
SET @loc_far = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t13_g_shut', 12.9720000, 77.5950000);
SET @loc_shut = LAST_INSERT_ID();

INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@loc_near, 'zz_t13 near warehouse', 'WAREHOUSE', 'OPERATIONAL');
SET @c_near = LAST_INSERT_ID();
INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@loc_ltd, 'zz_t13 limited depot', 'DEPOT', 'LIMITED');
SET @c_ltd = LAST_INSERT_ID();
INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@loc_far, 'zz_t13 far hospital', 'HOSPITAL', 'OPERATIONAL');
SET @c_far = LAST_INSERT_ID();
INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@loc_shut, 'zz_t13 closed camp', 'RELIEF_CAMP', 'CLOSED');
SET @c_shut = LAST_INSERT_ID();

INSERT INTO emergency (name, type, start_time, status)
VALUES ('zz_t13 active flood', 'FLOOD', @now - INTERVAL 2 DAY, 'ACTIVE');
SET @em = LAST_INSERT_ID();
INSERT INTO emergency (name, type, start_time, end_time, status)
VALUES ('zz_t13 closed fire', 'FIRE', @now - INTERVAL 9 DAY, @now - INTERVAL 4 DAY, 'CLOSED');
SET @em_closed = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@em, @loc_imp, 'ACTIVE');
SET @imp = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@em_closed, @loc_imp_closed, 'RESOLVED');
SET @imp_closed = LAST_INSERT_ID();

INSERT INTO resource (name, category, unit) VALUES ('zz_t13 water', 'WATER', 'L');
SET @r_water = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t13 rations', 'FOOD', 'packs');
SET @r_food = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t13 tent', 'SHELTER', 'tents');
SET @r_tent = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t13 med kit', 'MEDICAL', 'kits');
SET @r_kit = LAST_INSERT_ID();

-- Batches. The near one goes through sp_add_batch (RECEIPT by @u2).
CALL sp_add_batch(@r_water, @c_near, 'zz_t13_W_NEAR', 100, CURDATE() + INTERVAL 30 DAY, @u2, @b_near);
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
VALUES (@r_water, @c_near, 'zz_t13_W_EXPIRED', 50, CURDATE() - INTERVAL 1 DAY);
SET @b_exp = LAST_INSERT_ID();
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
VALUES (@r_water, @c_near, 'zz_t13_W_NOEXP', 40, NULL);
SET @b_noexp = LAST_INSERT_ID();
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
VALUES (@r_water, @c_ltd, 'zz_t13_W_LTD', 60, CURDATE() + INTERVAL 10 DAY);
SET @b_ltd = LAST_INSERT_ID();
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
VALUES (@r_water, @c_far, 'zz_t13_W_FAR', 200, CURDATE() + INTERVAL 5 DAY);
SET @b_far = LAST_INSERT_ID();
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
VALUES (@r_water, @c_shut, 'zz_t13_W_SHUT', 500, CURDATE() + INTERVAL 30 DAY);
SET @b_shut = LAST_INSERT_ID();
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
VALUES (@r_food, @c_near, 'zz_t13_F_NEAR', 100, CURDATE() + INTERVAL 30 DAY);
SET @b_food = LAST_INSERT_ID();
-- Med kits, only for the suggestions check.
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date) VALUES
    (@r_kit, @c_near, 'zz_t13_K_NEAR_20D',   20, CURDATE() + INTERVAL 20 DAY),
    (@r_kit, @c_near, 'zz_t13_K_NEAR_NOEXP', 30, NULL),
    (@r_kit, @c_near, 'zz_t13_K_NEAR_EXP',   50, CURDATE() - INTERVAL 1 DAY),
    (@r_kit, @c_near, 'zz_t13_K_NEAR_EMPTY',  0, CURDATE() + INTERVAL 20 DAY),
    (@r_kit, @c_ltd,  'zz_t13_K_LTD',        60, CURDATE() + INTERVAL 10 DAY),
    (@r_kit, @c_far,  'zz_t13_K_FAR',       200, CURDATE() + INTERVAL 5 DAY),
    (@r_kit, @c_shut, 'zz_t13_K_SHUT',      500, CURDATE() + INTERVAL 30 DAY);

-- Requests
INSERT INTO resource_request (impact_id, user_id, requested_at) VALUES (@imp, @u1, @now - INTERVAL 2 HOUR);
SET @req1 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req1, @r_water, 150, 'HIGH');
SET @i_water = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req1, @r_food, 30, 'MEDIUM');
SET @i_food = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req1, @r_tent, 10, 'LOW');
SET @i_tent = LAST_INSERT_ID();
INSERT INTO resource_request (impact_id, user_id, requested_at) VALUES (@imp_closed, @u1, @now - INTERVAL 5 DAY);
SET @req_closed = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req_closed, @r_water, 5, 'HIGH');
SET @i_closed = LAST_INSERT_ID();
INSERT INTO resource_request (impact_id, user_id, requested_at) VALUES (@imp, @u1, @now - INTERVAL 1 HOUR);
SET @req5 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req5, @r_kit, 120, 'CRITICAL');
SET @i_kit = LAST_INSERT_ID();

-- ---- allocations refused before anything is allocated ----
CALL sp_test_expect(CONCAT('CALL sp_allocate(', @i_water, ', ', @b_exp, ', 10, ', @u1, ', @aid)'), @errno, @msg);
SET @c = 'T05 allocate from an expired batch', @e = CONCAT('1644: Batch expired on ', CURDATE() - INTERVAL 1 DAY),
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'T05 nothing written (allocations/batch qty)', @e = '0/50.00',
    @a = CONCAT_WS('/', (SELECT COUNT(*) FROM allocation WHERE request_item_id = @i_water),
                        (SELECT quantity_available FROM stock WHERE stock_id = @b_exp));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_allocate(', @i_water, ', ', @b_ltd, ', 61, ', @u1, ', @aid)'), @errno, @msg);
SET @c = 'T07 allocate more than the batch holds', @e = '1644: Insufficient stock in this batch',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'T07 rolled back (allocations/batch qty/ledger rows)', @e = '0/60.00/1',
    @a = CONCAT_WS('/', (SELECT COUNT(*) FROM allocation WHERE request_item_id = @i_water),
                        (SELECT quantity_available FROM stock WHERE stock_id = @b_ltd),
                        (SELECT COUNT(*) FROM stock_ledger WHERE stock_id = @b_ltd));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'ledger variables clear after a failed allocation', @e = '-/-/-',
    @a = CONCAT_WS('/', COALESCE(@ledger_reason, '-'), COALESCE(@ledger_alloc, '-'), COALESCE(@ledger_user, '-'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_allocate(', @i_water, ', ', @b_shut, ', 1, ', @u1, ', @aid)'), @errno, @msg);
SET @c = 'allocate from a CLOSED center', @e = '1644: Center zz_t13 closed camp is CLOSED',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_allocate(', @i_closed, ', ', @b_noexp, ', 1, ', @u1, ', @aid)'), @errno, @msg);
SET @c = 'allocate in a CLOSED emergency', @e = '1644: Emergency is CLOSED',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_allocate(', @i_water, ', ', @b_food, ', 1, ', @u1, ', @aid)'), @errno, @msg);
SET @c = 'allocate a batch of another resource', @e = '1644: Batch holds a different resource than the item',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_allocate(', @i_water, ', ', @b_near, ', 0, ', @u1, ', @aid)'), @errno, @msg);
SET @c = 'allocate 0', @e = '1644: Quantity to allocate must be greater than 0',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_allocate(-1, ', @b_near, ', 1, ', @u1, ', @aid)'), @errno, @msg);
SET @c = 'allocate to a missing item', @e = '1644: Request item -1 not found',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_allocate(', @i_water, ', -1, 1, ', @u1, ', @aid)'), @errno, @msg);
SET @c = 'allocate from a missing batch', @e = '1644: Batch -1 not found',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('INSERT INTO allocation (request_item_id, stock_id, user_id, quantity_allocated, status) VALUES (',
                           @i_water, ', ', @b_near, ', ', @u1, ', 1, ''DISPATCHED'')'), @errno, @msg);
SET @c = 'insert an allocation as DISPATCHED', @e = '1644: New allocations start RESERVED',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ---- allocate ----
CALL sp_allocate(@i_water, @b_near, 100, @u1, @a1);
SET @c = 'allocation starts RESERVED and takes the stock', @e = 'RESERVED/0.00',
    @a = CONCAT_WS('/', (SELECT status FROM allocation WHERE allocation_id = @a1),
                        (SELECT quantity_available FROM stock WHERE stock_id = @b_near));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'ALLOCATION ledger row (reason/change/balance/alloc/by)', @e = 'ALLOCATION/-100.00/0.00/1/1',
    @a = (SELECT CONCAT_WS('/', reason, change_qty, balance_after, allocation_id <=> @a1, changed_by <=> @u1)
            FROM stock_ledger WHERE stock_id = @b_near ORDER BY ledger_id DESC LIMIT 1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'item PARTIAL, request PARTIALLY_FULFILLED', @e = 'PARTIAL/PARTIALLY_FULFILLED',
    @a = CONCAT_WS('/', (SELECT status FROM request_item WHERE request_item_id = @i_water),
                        (SELECT status FROM resource_request WHERE request_id = @req1));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'ledger variables clear after an allocation', @e = '-/-/-',
    @a = CONCAT_WS('/', COALESCE(@ledger_reason, '-'), COALESCE(@ledger_alloc, '-'), COALESCE(@ledger_user, '-'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_allocate(@i_water, @b_ltd, 20, @u1, @a_ltd);
SET @c = 'allocate from a LIMITED center', @e = 'RESERVED/40.00',
    @a = CONCAT_WS('/', (SELECT status FROM allocation WHERE allocation_id = @a_ltd),
                        (SELECT quantity_available FROM stock WHERE stock_id = @b_ltd));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_allocate(', @i_water, ', ', @b_far, ', 31, ', @u1, ', @aid)'), @errno, @msg);
SET @c = 'T06 allocate past what the item still needs', @e = '1644: Only 30.00 left to allocate for this item',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- T11: fill the water item, fill the food item, cancel the tent item.
CALL sp_allocate(@i_water, @b_far, 30, @u1, @a_far);
CALL sp_allocate(@i_food, @b_food, 30, @u1, @a_food);
UPDATE request_item SET status = 'CANCELLED' WHERE request_item_id = @i_tent;
SET @c = 'T11 fully allocated item is FULFILLED', @e = 'FULFILLED',
    @a = (SELECT status FROM request_item WHERE request_item_id = @i_water);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'T11 request FULFILLED (one item CANCELLED)', @e = 'FULFILLED',
    @a = (SELECT status FROM resource_request WHERE request_id = @req1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_allocate(', @i_water, ', ', @b_noexp, ', 1, ', @u1, ', @aid)'), @errno, @msg);
SET @c = 'allocate to a FULFILLED item', @e = '1644: Item is FULFILLED; only PENDING or PARTIAL items can be allocated',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_allocate(', @i_tent, ', ', @b_noexp, ', 1, ', @u1, ', @aid)'), @errno, @msg);
SET @c = 'allocate to a CANCELLED item', @e = '1644: Item is CANCELLED; only PENDING or PARTIAL items can be allocated',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ---- cancel and other transitions ----
CALL sp_cancel_allocation(@a_far, @u2);
SET @c = 'T09 cancel returns the stock', @e = 200.00,
    @a = (SELECT quantity_available FROM stock WHERE stock_id = @b_far);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'T09 ledger row (reason/change/balance/alloc/by)', @e = 'ALLOCATION_CANCELLED/30.00/200.00/1/1',
    @a = (SELECT CONCAT_WS('/', reason, change_qty, balance_after, allocation_id <=> @a_far, changed_by <=> @u2)
            FROM stock_ledger WHERE stock_id = @b_far ORDER BY ledger_id DESC LIMIT 1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'T09 item recomputed, request follows', @e = 'PARTIAL/PARTIALLY_FULFILLED',
    @a = CONCAT_WS('/', (SELECT status FROM request_item WHERE request_item_id = @i_water),
                        (SELECT status FROM resource_request WHERE request_id = @req1));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'ledger variables clear after a cancel', @e = '-/-/-',
    @a = CONCAT_WS('/', COALESCE(@ledger_reason, '-'), COALESCE(@ledger_alloc, '-'), COALESCE(@ledger_user, '-'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_cancel_allocation(', @a_far, ', ', @u2, ')'), @errno, @msg);
SET @c = 'cancel an allocation twice', @e = '1644: Allocation is already CANCELLED',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'ledger variables clear after a failed cancel', @e = '-/-/-',
    @a = CONCAT_WS('/', COALESCE(@ledger_reason, '-'), COALESCE(@ledger_alloc, '-'), COALESCE(@ledger_user, '-'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect('CALL sp_cancel_allocation(-1, NULL)', @errno, @msg);
SET @c = 'cancel a missing allocation', @e = '1644: Allocation -1 not found',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('UPDATE allocation SET status = ''DISPATCHED'' WHERE allocation_id = ', @a1), @errno, @msg);
SET @c = 'RESERVED -> DISPATCHED', @e = '0: ', @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE allocation SET status = ''DELIVERED'' WHERE allocation_id = ', @a1), @errno, @msg);
SET @c = 'DISPATCHED -> DELIVERED', @e = '0: ', @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'delivery leaves the stock alone (status/batch qty)', @e = 'DELIVERED/0.00',
    @a = CONCAT_WS('/', (SELECT status FROM allocation WHERE allocation_id = @a1),
                        (SELECT quantity_available FROM stock WHERE stock_id = @b_near));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('CALL sp_cancel_allocation(', @a1, ', ', @u2, ')'), @errno, @msg);
SET @c = 'DELIVERED -> CANCELLED refused', @e = '1644: Allocation can''t go from DELIVERED to CANCELLED',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE allocation SET status = ''DISPATCHED'' WHERE allocation_id = ', @a1), @errno, @msg);
SET @c = 'DELIVERED -> DISPATCHED refused', @e = '1644: Allocation can''t go from DELIVERED to DISPATCHED',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE allocation SET status = ''RESERVED'' WHERE allocation_id = ', @a_far), @errno, @msg);
SET @c = 'CANCELLED -> RESERVED refused', @e = '1644: Allocation can''t go from CANCELLED to RESERVED',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE allocation SET status = ''DELIVERED'' WHERE allocation_id = ', @a_food), @errno, @msg);
SET @c = 'RESERVED -> DELIVERED refused', @e = '1644: Allocation can''t go from RESERVED to DELIVERED',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

UPDATE allocation SET status = 'DISPATCHED' WHERE allocation_id = @a_ltd;
CALL sp_test_expect(CONCAT('CALL sp_cancel_allocation(', @a_ltd, ', ', @u2, ')'), @errno, @msg);
SET @c = 'DISPATCHED -> CANCELLED (status/batch qty)', @e = '0/CANCELLED/60.00',
    @a = CONCAT_WS('/', @errno, (SELECT status FROM allocation WHERE allocation_id = @a_ltd),
                        (SELECT quantity_available FROM stock WHERE stock_id = @b_ltd));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- Fixed columns (on @a_food, RESERVED).
CALL sp_test_expect(CONCAT('UPDATE allocation SET quantity_allocated = 1 WHERE allocation_id = ', @a_food), @errno, @msg);
SET @c = 'allocation quantity is fixed', @e = '1644: Allocation quantity_allocated can''t change',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE allocation SET stock_id = ', @b_near, ' WHERE allocation_id = ', @a_food), @errno, @msg);
SET @c = 'allocation batch is fixed', @e = '1644: Allocation stock_id can''t change',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE allocation SET request_item_id = ', @i_water, ' WHERE allocation_id = ', @a_food), @errno, @msg);
SET @c = 'allocation item is fixed', @e = '1644: Allocation request_item_id can''t change',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE allocation SET user_id = ', @u2, ' WHERE allocation_id = ', @a_food), @errno, @msg);
SET @c = 'allocation user is fixed', @e = '1644: Allocation user_id can''t change',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE allocation SET allocated_at = allocated_at - INTERVAL 1 DAY WHERE allocation_id = ', @a_food), @errno, @msg);
SET @c = 'allocation time is fixed', @e = '1644: Allocation allocated_at can''t change',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
-- The app user gets the generic FK errors 1217/1216; only accounts with more
-- privileges see the detailed 1451/1452.
CALL sp_test_expect(CONCAT('DELETE FROM allocation WHERE allocation_id = ', @a_food), @errno, @msg);
SET @c = 'delete an allocation (FK from its ledger rows, errno)', @e = 1217, @a = @errno;
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ---- suggestions (med kits; the item needs 120) ----
SET @c = 'suggested batches in order (code:suggested)',
    @e = 'zz_t13_K_NEAR_20D:20.00,zz_t13_K_NEAR_NOEXP:30.00,zz_t13_K_LTD:60.00,zz_t13_K_FAR:10.00',
    @a = (SELECT GROUP_CONCAT(CONCAT(batch_code, ':', suggested_qty) ORDER BY suggestion_rank)
            FROM v_batch_suggestions WHERE request_item_id = @i_kit);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'suggested split covers what the item needs', @e = 120.00,
    @a = (SELECT SUM(suggested_qty) FROM v_batch_suggestions WHERE request_item_id = @i_kit);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect('CALL sp_suggest_batches(-1)', @errno, @msg);
SET @c = 'suggest for a missing item', @e = '1644: Request item -1 not found',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
-- (This call also prints its result set.)
CALL sp_test_expect(CONCAT('CALL sp_suggest_batches(', @i_kit, ')'), @errno, @msg);
SET @c = 'sp_suggest_batches runs', @e = '0: ', @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ---- every fixture item: the kept total matches its allocations ----
SET @c = 'quantity_allocated = sum of allocations, every item (mismatches)', @e = 0,
    @a = (SELECT COUNT(*) FROM request_item ri
            JOIN resource_request rr ON rr.request_id = ri.request_id
           WHERE rr.user_id = @u1
             AND ri.quantity_allocated <> fn_item_allocated(ri.request_item_id));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'queue''s quantity_allocated = request_item.quantity_allocated (mismatches)', @e = 0,
    @a = (SELECT COUNT(*) FROM v_priority_queue q
            JOIN request_item ri ON ri.request_item_id = q.request_item_id
            JOIN resource_request rr ON rr.request_id = ri.request_id
           WHERE rr.user_id = @u1
             AND q.quantity_allocated <> ri.quantity_allocated);
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

SELECT 't_p1_3_allocation' AS file, JSON_LENGTH(@results) AS checks, @failures AS failures,
       IF(@failures = 0, 'PASS', 'FAIL') AS result;
