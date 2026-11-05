-- t_p1_3_items_requests.sql — P1.3 items and requests: the request_item and
-- resource_request triggers (status rollup and guards), their CHECKs, and the
-- user UNIQUE email (02_alter.sql, 06_triggers.sql). Run with: npm run db:test
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
-- P1.3 items and requests, on a rolled-back fixture
-- ===========================================================================
-- Expected errors go through sp_test_expect (08_test_support.sql) and are
-- compared as '<errno>: <message>'; 1644 is a SIGNAL '45000' from our rules.
SET @section = 'P1.3 items';
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

-- Places: the impact in Bengaluru and one center about 1 km away.
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t13_g_impact', 12.9716000, 77.5946000);
SET @loc_imp = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t13_g_near', 12.9800000, 77.6000000);
SET @loc_near = LAST_INSERT_ID();
INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@loc_near, 'zz_t13 near warehouse', 'WAREHOUSE', 'OPERATIONAL');
SET @c_near = LAST_INSERT_ID();

INSERT INTO emergency (name, type, start_time, status)
VALUES ('zz_t13 active flood', 'FLOOD', @now - INTERVAL 2 DAY, 'ACTIVE');
SET @em = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@em, @loc_imp, 'ACTIVE');
SET @imp = LAST_INSERT_ID();

INSERT INTO resource (name, category, unit) VALUES ('zz_t13 water', 'WATER', 'L');
SET @r_water = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t13 rations', 'FOOD', 'packs');
SET @r_food = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t13 tent', 'SHELTER', 'tents');
SET @r_tent = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t13 med kit', 'MEDICAL', 'kits');
SET @r_kit = LAST_INSERT_ID();

-- One batch with no expiry, for the allocated item's checks.
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
VALUES (@r_water, @c_near, 'zz_t13_W_NOEXP', 40, NULL);
SET @b_noexp = LAST_INSERT_ID();

-- Requests
INSERT INTO resource_request (impact_id, user_id, requested_at) VALUES (@imp, @u1, @now - INTERVAL 2 HOUR);
SET @req1 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req1, @r_water, 150, 'HIGH');
SET @i_water = LAST_INSERT_ID();
INSERT INTO resource_request (impact_id, user_id, requested_at) VALUES (@imp, @u1, @now - INTERVAL 1 HOUR);
SET @req2 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req2, @r_water, 10, 'LOW');
SET @g1 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req2, @r_food, 5, 'LOW');
SET @g2 = LAST_INSERT_ID();
INSERT INTO resource_request (impact_id, user_id, requested_at) VALUES (@imp, @u1, @now - INTERVAL 1 HOUR);
SET @req3 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req3, @r_food, 1, 'LOW');
INSERT INTO resource_request (impact_id, user_id, requested_at) VALUES (@imp, @u1, @now - INTERVAL 1 HOUR);
SET @req4 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req4, @r_food, 2, 'LOW');
SET @i_only = LAST_INSERT_ID();

-- ---- Appendix A: constraints ----
CALL sp_test_expect(CONCAT('INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (',
                           @req3, ', ', @r_tent, ', 1, ''URGENT'')'), @errno, @msg);
SET @c = 'T02 item with urgency URGENT', @e = '3819: Check constraint ''chk_request_item_urgency'' is violated.',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- Allowed values compare exactly (utf8mb4_0900_bin): no case folding, no padding.
CALL sp_test_expect(CONCAT('INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (',
                           @req3, ', ', @r_tent, ', 1, ''critical'')'), @errno, @msg);
SET @c = 'item with urgency critical (lowercase)', @e = '3819: Check constraint ''chk_request_item_urgency'' is violated.',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (',
                           @req3, ', ', @r_tent, ', 1, ''HIGH '')'), @errno, @msg);
SET @c = 'item with urgency ''HIGH '' (trailing space)', @e = '3819: Check constraint ''chk_request_item_urgency'' is violated.',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('INSERT INTO `user` (role_id, name, email, password_hash) VALUES (',
                           @role, ', ''zz_t13 copy'', ''zz_t13_alloc@eras.test'', ''x'')'), @errno, @msg);
SET @c = 'T04 two users with the same email (errno)', @e = 1062, @a = @errno;
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ---- item guards ----
CALL sp_test_expect(CONCAT('UPDATE request_item SET status = ''FULFILLED'' WHERE request_item_id = ', @g1), @errno, @msg);
SET @c = 'hand-set item status refused', @e = '1644: Item status follows its allocations (would be PENDING)',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency, status) VALUES (',
                           @req2, ', ', @r_tent, ', 1, ''LOW'', ''FULFILLED'')'), @errno, @msg);
SET @c = 'new item inserted as FULFILLED', @e = '1644: New items start PENDING',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_allocate(@g1, @b_noexp, 10, @u1, @a_g1);
UPDATE request_item SET quantity_requested = 20 WHERE request_item_id = @g1;
SET @c = 'raising a FULFILLED item''s quantity makes it PARTIAL', @e = 'PARTIAL',
    @a = (SELECT status FROM request_item WHERE request_item_id = @g1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE request_item SET quantity_requested = 5 WHERE request_item_id = ', @g1), @errno, @msg);
SET @c = 'quantity below what is allocated', @e = '1644: Requested quantity can''t go below the 10.00 already allocated',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE request_item SET status = ''CANCELLED'' WHERE request_item_id = ', @g1), @errno, @msg);
SET @c = 'cancel an item with an active allocation', @e = '1644: Cancel this item''s allocations first',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE request_item SET request_id = ', @req1, ' WHERE request_item_id = ', @g1), @errno, @msg);
SET @c = 'move an item to another request', @e = '1644: An item can''t move to another request',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE request_item SET resource_id = ', @r_kit, ' WHERE request_item_id = ', @g1), @errno, @msg);
SET @c = 'change an allocated item''s resource', @e = '1644: An item''s resource can''t change once it has allocations',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('UPDATE request_item SET status = ''CANCELLED'' WHERE request_item_id = ', @g2), @errno, @msg);
SET @c = 'cancel an item with no allocations', @e = '0: ', @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE request_item SET status = ''PENDING'' WHERE request_item_id = ', @g2), @errno, @msg);
SET @c = 'reopen a cancelled item', @e = '1644: A cancelled item can''t be reopened',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
UPDATE request_item SET quantity_requested = 7 WHERE request_item_id = @g2;
SET @c = 'a quantity edit keeps a cancelled item CANCELLED', @e = 'CANCELLED/7.00',
    @a = (SELECT CONCAT_WS('/', status, quantity_requested) FROM request_item WHERE request_item_id = @g2);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('UPDATE request_item SET quantity_allocated = 0 WHERE request_item_id = ', @g1), @errno, @msg);
SET @c = 'hand edit of quantity_allocated', @e = '1644: quantity_allocated is kept by the allocation triggers',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('INSERT INTO request_item (request_id, resource_id, quantity_requested, quantity_allocated, urgency) VALUES (',
                           @req2, ', ', @r_tent, ', 5, 5, ''LOW'')'), @errno, @msg);
SET @c = 'new item inserted with quantity_allocated 5', @e = '1644: New items start with nothing allocated',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'ledger and item-sync variables clear', @e = '-/-/-/-',
    @a = CONCAT_WS('/', COALESCE(@ledger_reason, '-'), COALESCE(@ledger_alloc, '-'), COALESCE(@ledger_user, '-'),
                        COALESCE(@item_alloc_sync, '-'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ---- request rollup and guard ----
SET @c = 'request with untouched items is OPEN', @e = 'OPEN',
    @a = (SELECT status FROM resource_request WHERE request_id = @req3);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
UPDATE request_item SET status = 'CANCELLED' WHERE request_item_id = @i_only;
SET @c = 'request whose items are all CANCELLED', @e = 'CANCELLED',
    @a = (SELECT status FROM resource_request WHERE request_id = @req4);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('UPDATE resource_request SET status = ''FULFILLED'' WHERE request_id = ', @req3), @errno, @msg);
SET @c = 'hand-set request status refused', @e = '1644: Request status follows its items (would be OPEN)',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
CALL sp_test_expect(CONCAT('INSERT INTO resource_request (impact_id, user_id, status) VALUES (',
                           @imp, ', ', @u1, ', ''FULFILLED'')'), @errno, @msg);
SET @c = 'new request inserted as FULFILLED', @e = '1644: New requests start OPEN',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
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

SELECT 't_p1_3_items_requests' AS file, JSON_LENGTH(@results) AS checks, @failures AS failures,
       IF(@failures = 0, 'PASS', 'FAIL') AS result;
