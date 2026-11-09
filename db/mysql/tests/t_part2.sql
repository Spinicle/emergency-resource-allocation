-- t_part2.sql — P2.5's analytics views and P2.1/P2.2's full-text indexes
-- (10_search.sql, 11_analytics_views.sql). Run with: npm run db:test
--
-- Runs as the app user (MYSQL_USER), so it also proves the app's privileges.
-- Safe on an empty or a seeded database:
--   * the fixture only adds rows: roles are looked up by name and inserted only
--     if missing; every UNIQUE value starts with zz_t2_
--   * assertions are limited to the fixture's own ids, except the object checks
--     and the seeded-term checks below
--   * the fixture is rolled back, and row counts are checked before and after
--
-- InnoDB's full-text index only sees committed rows, so a rolled-back fixture
-- can't be searched for. The search checks use the seeded rows instead, behind
-- t_seed's gate: while the seed is untouched and it's the seed day they run,
-- otherwise those rows print SKIP with the reason.
--
-- Each check appends [section, check, expected, actual, result] to @results, a
-- JSON array in a user variable (the app user can't create temporary tables).
-- The append line is repeated on purpose, never PREPAREd: MySQL fixes
-- user-variable types at PREPARE time. The file ends with one row per check and
-- a summary row. It runs on its own in the mysql CLI or Workbench.

SET @results = JSON_ARRAY();

-- Row counts of every table, as one string. Prepared once, run before and after
-- the rolled-back fixture. (Safe to prepare: it reads no user variables.)
PREPARE snapshot_counts FROM 'SET @counts = CONCAT_WS('','',
    (SELECT COUNT(*) FROM role), (SELECT COUNT(*) FROM `user`), (SELECT COUNT(*) FROM location),
    (SELECT COUNT(*) FROM emergency), (SELECT COUNT(*) FROM emergency_impact),
    (SELECT COUNT(*) FROM impact_observation), (SELECT COUNT(*) FROM resource),
    (SELECT COUNT(*) FROM resource_center), (SELECT COUNT(*) FROM stock),
    (SELECT COUNT(*) FROM stock_ledger), (SELECT COUNT(*) FROM resource_request),
    (SELECT COUNT(*) FROM request_item), (SELECT COUNT(*) FROM allocation))';

EXECUTE snapshot_counts;
SET @counts_before = @counts;

START TRANSACTION;
SET @now = NOW();

-- ---------------------------------------------------------------------------
-- The fixture: one user, one location and center, four resources with batches
-- ---------------------------------------------------------------------------
INSERT INTO role (role_name)
SELECT 'COORDINATOR' FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM role WHERE role_name = 'COORDINATOR');
SET @role = (SELECT role_id FROM role WHERE role_name = 'COORDINATOR');
INSERT INTO `user` (role_id, name, email, password_hash)
VALUES (@role, 'zz_t2 allocator', 'zz_t2_alloc@eras.test', 'not-a-real-hash');
SET @u = LAST_INSERT_ID();

INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t2_base', 12.5, 77.5);
SET @l = LAST_INSERT_ID();
INSERT INTO resource_center (location_id, name, center_type, status) VALUES (@l, 'zz_t2 center', 'DEPOT', 'OPERATIONAL');
SET @center = LAST_INSERT_ID();

INSERT INTO resource (name, category, unit) VALUES ('zz_t2 water', 'WATER', 'L');
SET @r_water = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t2 kit', 'MEDICAL', 'kit');
SET @r_kit = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t2 rope', 'RESCUE', 'coil');
SET @r_rope = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t2 tent', 'SHELTER', 'unit');
SET @r_tent = LAST_INSERT_ID();

CALL sp_add_batch(@r_water, @center, 'zz_t2_water', 1000, NULL, @u, @s_water);
CALL sp_add_batch(@r_kit, @center, 'zz_t2_kit', 10, NULL, @u, @s_kit);
CALL sp_add_batch(@r_tent, @center, 'zz_t2_tent', 10, NULL, @u, @s_tent);

-- ===========================================================================
-- A. v_unmet_demand
-- ===========================================================================
SET @section = 'A unmet';

INSERT INTO emergency (name, type, start_time, status) VALUES ('zz_t2 unmet', 'FLOOD', @now - INTERVAL 1 DAY, 'ACTIVE');
SET @e_unmet = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_unmet, @l, 'ACTIVE');
SET @imp_unmet = LAST_INSERT_ID();

-- One item with three allocations, one of them cancelled.
INSERT INTO resource_request (impact_id, user_id) VALUES (@imp_unmet, @u);
SET @rq1 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq1, @r_water, 10, 'HIGH');
SET @i1 = LAST_INSERT_ID();
CALL sp_allocate(@i1, @s_water, 3, @u, @a1);
CALL sp_allocate(@i1, @s_water, 4, @u, @a2);
CALL sp_allocate(@i1, @s_water, 2, @u, @a3);
CALL sp_cancel_allocation(@a3, @u);

SET @c = 'several allocations on one item: no fan-out', @e = '1 item, 10.00 requested, 7.00 allocated, 3.00 unmet',
    @a = (SELECT CONCAT(item_count, ' item, ', quantity_requested, ' requested, ', quantity_allocated, ' allocated, ', quantity_unmet, ' unmet')
            FROM v_unmet_demand WHERE emergency_id = @e_unmet AND resource_id = @r_water);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- A second live item of the same resource, in another request.
INSERT INTO resource_request (impact_id, user_id) VALUES (@imp_unmet, @u);
SET @rq2 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq2, @r_water, 5, 'LOW');

SET @c = 'a second live item of the resource adds up', @e = '2 items, 15.00 requested, 7.00 allocated, 8.00 unmet',
    @a = (SELECT CONCAT(item_count, ' items, ', quantity_requested, ' requested, ', quantity_allocated, ' allocated, ', quantity_unmet, ' unmet')
            FROM v_unmet_demand WHERE emergency_id = @e_unmet AND resource_id = @r_water);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- A live request with one cancelled item, and a request that's cancelled whole.
INSERT INTO resource_request (impact_id, user_id) VALUES (@imp_unmet, @u);
SET @rq3 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq3, @r_water, 3, 'LOW');
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq3, @r_kit, 9, 'LOW');
UPDATE request_item SET status = 'CANCELLED' WHERE request_id = @rq3 AND resource_id = @r_kit;

INSERT INTO resource_request (impact_id, user_id) VALUES (@imp_unmet, @u);
SET @rq4 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq4, @r_rope, 7, 'LOW');
UPDATE request_item SET status = 'CANCELLED' WHERE request_id = @rq4;

SET @c = 'the request cancelled whole is CANCELLED', @e = 'CANCELLED',
    @a = (SELECT status FROM resource_request WHERE request_id = @rq4);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'a cancelled item is left out, its live sibling counts', @e = '3 items, 18.00 requested, 7.00 allocated, 11.00 unmet',
    @a = (SELECT CONCAT(item_count, ' items, ', quantity_requested, ' requested, ', quantity_allocated, ' allocated, ', quantity_unmet, ' unmet')
            FROM v_unmet_demand WHERE emergency_id = @e_unmet AND resource_id = @r_water);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'a resource with only a cancelled item has no row', @e = 0,
    @a = (SELECT COUNT(*) FROM v_unmet_demand WHERE emergency_id = @e_unmet AND resource_id = @r_kit);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'a resource only in a cancelled request has no row', @e = 0,
    @a = (SELECT COUNT(*) FROM v_unmet_demand WHERE emergency_id = @e_unmet AND resource_id = @r_rope);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- Fully served: the row stays, with nothing unmet.
INSERT INTO resource_request (impact_id, user_id) VALUES (@imp_unmet, @u);
SET @rq5 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq5, @r_tent, 2, 'LOW');
SET @i5 = LAST_INSERT_ID();
CALL sp_allocate(@i5, @s_tent, 2, @u, @a5);

SET @c = 'a fully served resource keeps its row, unmet 0', @e = '2.00 allocated, 0.00 unmet',
    @a = (SELECT CONCAT(quantity_allocated, ' allocated, ', quantity_unmet, ' unmet')
            FROM v_unmet_demand WHERE emergency_id = @e_unmet AND resource_id = @r_tent);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'allocated equals request_item.quantity_allocated',
    @e = (SELECT SUM(ri.quantity_allocated)
            FROM request_item ri JOIN resource_request rr ON rr.request_id = ri.request_id
           WHERE rr.impact_id = @imp_unmet AND ri.status <> 'CANCELLED' AND rr.status <> 'CANCELLED'),
    @a = (SELECT SUM(quantity_allocated) FROM v_unmet_demand WHERE emergency_id = @e_unmet);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ===========================================================================
-- B. v_fulfilment_rate
-- ===========================================================================
SET @section = 'B fulfilment';

SET @c = 'item counts: fulfilled, partial, pending', @e = '4 items: 1 fulfilled, 1 partial, 2 pending',
    @a = (SELECT CONCAT(items_total, ' items: ', items_fulfilled, ' fulfilled, ', items_partial, ' partial, ', items_pending, ' pending')
            FROM v_fulfilment_rate WHERE emergency_id = @e_unmet);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

INSERT INTO emergency (name, type, start_time, status) VALUES ('zz_t2 empty', 'FIRE', @now - INTERVAL 1 DAY, 'ACTIVE');
SET @e_empty = LAST_INSERT_ID();

SET @c = 'no items: the row exists, rates NULL', @e = '0 items, rates NULL / NULL',
    @a = (SELECT CONCAT(items_total, ' items, rates ', COALESCE(item_rate_pct, 'NULL'), ' / ', COALESCE(quantity_rate_pct, 'NULL'))
            FROM v_fulfilment_rate WHERE emergency_id = @e_empty);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

INSERT INTO emergency (name, type, start_time, status) VALUES ('zz_t2 cancelled', 'FIRE', @now - INTERVAL 1 DAY, 'ACTIVE');
SET @e_cancelled = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_cancelled, @l, 'ACTIVE');
SET @imp_cancelled = LAST_INSERT_ID();
INSERT INTO resource_request (impact_id, user_id) VALUES (@imp_cancelled, @u);
SET @rq6 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq6, @r_kit, 2, 'LOW');
UPDATE request_item SET status = 'CANCELLED' WHERE request_id = @rq6;

SET @c = 'every item cancelled: counts 0, rates NULL', @e = '0 items, rates NULL / NULL',
    @a = (SELECT CONCAT(items_total, ' items, rates ', COALESCE(item_rate_pct, 'NULL'), ' / ', COALESCE(quantity_rate_pct, 'NULL'))
            FROM v_fulfilment_rate WHERE emergency_id = @e_cancelled);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- Mixed units: 100 of 100 L and 1 of 4 kits. A raw SUM would say 97.12.
INSERT INTO emergency (name, type, start_time, status) VALUES ('zz_t2 mixed', 'FLOOD', @now - INTERVAL 1 DAY, 'ACTIVE');
SET @e_mixed = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_mixed, @l, 'ACTIVE');
SET @imp_mixed = LAST_INSERT_ID();
INSERT INTO resource_request (impact_id, user_id) VALUES (@imp_mixed, @u);
SET @rq7 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq7, @r_water, 100, 'LOW');
SET @i7 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@rq7, @r_kit, 4, 'LOW');
SET @i8 = LAST_INSERT_ID();
CALL sp_allocate(@i7, @s_water, 100, @u, @a7);
CALL sp_allocate(@i8, @s_kit, 1, @u, @a8);

SET @c = 'mixed units: item rate 50, averaged share 62.5', @e = '50.00 / 62.50',
    @a = (SELECT CONCAT(item_rate_pct, ' / ', quantity_rate_pct) FROM v_fulfilment_rate WHERE emergency_id = @e_mixed);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

INSERT INTO emergency (name, type, start_time, end_time, status) VALUES ('zz_t2 closed', 'FIRE', @now - INTERVAL 2 DAY, @now - INTERVAL 1 DAY, 'CLOSED');
SET @e_closed = LAST_INSERT_ID();

SET @c = 'a CLOSED emergency keeps its row', @e = 'CLOSED',
    @a = (SELECT emergency_status FROM v_fulfilment_rate WHERE emergency_id = @e_closed);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ===========================================================================
-- C. v_escalating_impacts
-- ===========================================================================
SET @section = 'C escalating';

INSERT INTO emergency (name, type, start_time, status) VALUES ('zz_t2 escalating', 'LANDSLIDE', @now - INTERVAL 5 DAY, 'ACTIVE');
SET @e_esc = LAST_INSERT_ID();

INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t2_a_rising', 12.1, 77.1);
SET @lo = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_esc, @lo, 'ACTIVE');
SET @imp = LAST_INSERT_ID();
INSERT INTO impact_observation (impact_id, user_id, observed_at, affected_percentage, severity)
VALUES (@imp, @u, @now - INTERVAL 2 HOUR, 10, 'LOW'), (@imp, @u, @now - INTERVAL 1 HOUR, 40, 'HIGH');

INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t2_b_same', 12.2, 77.2);
SET @lo = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_esc, @lo, 'ACTIVE');
SET @imp = LAST_INSERT_ID();
INSERT INTO impact_observation (impact_id, user_id, observed_at, affected_percentage, severity)
VALUES (@imp, @u, @now - INTERVAL 2 HOUR, 40, 'HIGH'), (@imp, @u, @now - INTERVAL 1 HOUR, 45, 'HIGH');

INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t2_c_falling', 12.3, 77.3);
SET @lo = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_esc, @lo, 'ACTIVE');
SET @imp = LAST_INSERT_ID();
INSERT INTO impact_observation (impact_id, user_id, observed_at, affected_percentage, severity)
VALUES (@imp, @u, @now - INTERVAL 2 HOUR, 80, 'CRITICAL'), (@imp, @u, @now - INTERVAL 1 HOUR, 10, 'LOW');

INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t2_d_fell_then_rose', 12.4, 77.4);
SET @lo = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_esc, @lo, 'ACTIVE');
SET @imp = LAST_INSERT_ID();
INSERT INTO impact_observation (impact_id, user_id, observed_at, affected_percentage, severity)
VALUES (@imp, @u, @now - INTERVAL 3 HOUR, 80, 'CRITICAL'), (@imp, @u, @now - INTERVAL 2 HOUR, 10, 'LOW'), (@imp, @u, @now - INTERVAL 1 HOUR, 40, 'HIGH');

INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t2_e_rose_then_fell', 12.6, 77.6);
SET @lo = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_esc, @lo, 'ACTIVE');
SET @imp = LAST_INSERT_ID();
INSERT INTO impact_observation (impact_id, user_id, observed_at, affected_percentage, severity)
VALUES (@imp, @u, @now - INTERVAL 3 HOUR, 10, 'LOW'), (@imp, @u, @now - INTERVAL 2 HOUR, 80, 'CRITICAL'), (@imp, @u, @now - INTERVAL 1 HOUR, 10, 'LOW');

INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t2_f_single', 12.7, 77.7);
SET @lo = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@e_esc, @lo, 'ACTIVE');
SET @imp = LAST_INSERT_ID();
INSERT INTO impact_observation (impact_id, user_id, observed_at, affected_percentage, severity)
VALUES (@imp, @u, @now - INTERVAL 1 HOUR, 40, 'HIGH');

SET @c = 'only a worse latest observation is listed', @e = 'zz_t2_a_rising,zz_t2_d_fell_then_rose',
    @a = (SELECT GROUP_CONCAT(grid_id ORDER BY grid_id) FROM v_escalating_impacts WHERE emergency_id = @e_esc);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'a rising impact shows both severities and its rank', @e = 'LOW -> HIGH, ranks 1 -> 3',
    @a = (SELECT CONCAT(prev_severity, ' -> ', severity, ', ranks ', prev_rank, ' -> ', sev_rank)
            FROM v_escalating_impacts WHERE emergency_id = @e_esc AND grid_id = 'zz_t2_a_rising');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'only the latest pair counts, not the older peak', @e = 'LOW -> HIGH',
    @a = (SELECT CONCAT(prev_severity, ' -> ', severity)
            FROM v_escalating_impacts WHERE emergency_id = @e_esc AND grid_id = 'zz_t2_d_fell_then_rose');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ===========================================================================
-- D. Search: what doesn't depend on the seed
-- ===========================================================================
SET @section = 'D search';

-- An uncommitted row isn't in the full-text index yet, so this fixture can't be found.
INSERT INTO emergency (name, type, start_time, status, description)
VALUES ('zz_t2 search', 'OTHER', @now - INTERVAL 1 DAY, 'ACTIVE', 'zzttwouncommittedterm');

SET @c = 'an uncommitted row is not found (natural)', @e = 0,
    @a = (SELECT COUNT(*) FROM emergency WHERE MATCH(name, description) AGAINST ('zzttwouncommittedterm' IN NATURAL LANGUAGE MODE));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'an uncommitted row is not found (boolean)', @e = 0,
    @a = (SELECT COUNT(*) FROM emergency WHERE MATCH(name, description) AGAINST ('+zzttwouncommittedterm' IN BOOLEAN MODE));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- T17's string. Natural mode treats it as text. Boolean mode can't parse it,
-- which is why the app reduces search text to words first (src/lib/search.ts).
SET @c = 'T17 string, emergencies, natural mode: 0 rows', @e = 0,
    @a = (SELECT COUNT(*) FROM emergency WHERE MATCH(name, description) AGAINST ('\' OR 1=1 --' IN NATURAL LANGUAGE MODE));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'T17 string, requests, natural mode: 0 rows', @e = 0,
    @a = (SELECT COUNT(*) FROM resource_request WHERE MATCH(description) AGAINST ('\' OR 1=1 --' IN NATURAL LANGUAGE MODE));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

CALL sp_test_expect('SELECT COUNT(*) FROM emergency WHERE MATCH(name, description) AGAINST ("'' OR 1=1 --" IN BOOLEAN MODE)', @errno, @msg);
SET @c = 'T17 string, emergencies, raw boolean: syntax error', @e = 1064, @a = @errno;
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

CALL sp_test_expect('SELECT COUNT(*) FROM resource_request WHERE MATCH(description) AGAINST ("'' OR 1=1 --" IN BOOLEAN MODE)', @errno, @msg);
SET @c = 'T17 string, requests, raw boolean: syntax error', @e = 1064, @a = @errno;
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

ROLLBACK;

EXECUTE snapshot_counts;
DEALLOCATE PREPARE snapshot_counts;
SET @c = 'row counts unchanged after ROLLBACK', @e = @counts_before, @a = @counts;
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ===========================================================================
-- E. The objects 10_search.sql and 11_analytics_views.sql create
-- ===========================================================================
SET @section = 'E objects';

SET @c = 'both FULLTEXT indexes exist', @e = 'emergency.ftx_emergency_text,resource_request.ftx_request_desc',
    @a = (SELECT GROUP_CONCAT(DISTINCT CONCAT(TABLE_NAME, '.', INDEX_NAME) ORDER BY TABLE_NAME)
            FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND INDEX_TYPE = 'FULLTEXT');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'the three analytics views are SQL SECURITY INVOKER', @e = 3,
    @a = (SELECT COUNT(*) FROM information_schema.VIEWS
           WHERE TABLE_SCHEMA = DATABASE() AND SECURITY_TYPE = 'INVOKER'
             AND TABLE_NAME IN ('v_unmet_demand', 'v_fulfilment_rate', 'v_escalating_impacts'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ===========================================================================
-- F. Full-text search on the seeded rows
--
-- The same gate as t_seed: these run only while the database is untouched since
-- the seed, on the seed day; otherwise every row here prints SKIP with the
-- reason. Expected rows are found by name or description, never by id.
-- ===========================================================================
SET @section = 'F seeded search';

SET @seed_at = (SELECT MIN(e.end_time) + INTERVAL 14 DAY
                  FROM emergency e
                  JOIN emergency_impact ei ON ei.emergency_id = e.emergency_id
                  JOIN location l          ON l.location_id   = ei.location_id
                 WHERE l.grid_id = 'MYS-NR-MOHALLA');
SET @later =
      (SELECT COUNT(*) FROM stock_ledger sl JOIN stock s ON s.stock_id = sl.stock_id
        WHERE s.batch_code NOT LIKE 'zz\_%' AND sl.changed_at > @seed_at)
    + (SELECT COUNT(*) FROM allocation a JOIN stock s ON s.stock_id = a.stock_id
        WHERE s.batch_code NOT LIKE 'zz\_%' AND a.allocated_at > @seed_at)
    + (SELECT COUNT(*) FROM resource_request rr
         JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
         JOIN emergency e         ON e.emergency_id = ei.emergency_id
        WHERE e.name NOT LIKE 'zz\_%' AND rr.requested_at > @seed_at)
    + (SELECT COUNT(*) FROM impact_observation o
         JOIN emergency_impact ei ON ei.impact_id = o.impact_id
         JOIN emergency e         ON e.emergency_id = ei.emergency_id
        WHERE e.name NOT LIKE 'zz\_%' AND o.observed_at > @seed_at)
    + (SELECT COUNT(*) FROM emergency
        WHERE name NOT LIKE 'zz\_%' AND (start_time > @seed_at OR end_time > @seed_at));
SET @skip = CASE
    WHEN @seed_at IS NULL THEN 'SKIP: no seeded Mysuru emergency'
    WHEN @later > 0 THEN CONCAT('SKIP: ', @later, ' rows changed since the seed')
    WHEN CURDATE() <> DATE(@seed_at) THEN CONCAT('SKIP: seeded on ', DATE(@seed_at), ', today is ', CURDATE())
END;
SET @skipped_section = IF(@skip IS NULL, NULL, @section);

SET @c = 'emergencies, natural: dengue',
    @e = (SELECT GROUP_CONCAT(emergency_id ORDER BY emergency_id) FROM emergency WHERE name = 'Mysuru Dengue Outbreak'),
    @a = (SELECT GROUP_CONCAT(emergency_id ORDER BY emergency_id) FROM emergency WHERE MATCH(name, description) AGAINST ('dengue' IN NATURAL LANGUAGE MODE));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'emergencies, boolean prefix: +landslide*',
    @e = (SELECT GROUP_CONCAT(emergency_id ORDER BY emergency_id) FROM emergency WHERE name = 'Kodagu Landslide'),
    @a = (SELECT GROUP_CONCAT(emergency_id ORDER BY emergency_id) FROM emergency WHERE MATCH(name, description) AGAINST ('+landslide*' IN BOOLEAN MODE));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'emergencies, boolean exclusion: +flood* -landslide',
    @e = (SELECT GROUP_CONCAT(emergency_id ORDER BY emergency_id) FROM emergency WHERE name = 'Bengaluru Urban Flood'),
    @a = (SELECT GROUP_CONCAT(emergency_id ORDER BY emergency_id) FROM emergency WHERE MATCH(name, description) AGAINST ('+flood* -landslide' IN BOOLEAN MODE));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'requests, natural: flooded families',
    @e = (SELECT GROUP_CONCAT(request_id ORDER BY request_id) FROM resource_request
           WHERE description LIKE 'Bellandur lake overflow:%' OR description LIKE 'Rescue boats and life jackets%'
              OR description LIKE 'Mahadevapura: ground floors flooded%' OR description LIKE 'Koramangala 6th Block relief camp:%'
              OR description LIKE 'Madikeri: landslide-displaced%'),
    @a = (SELECT GROUP_CONCAT(request_id ORDER BY request_id) FROM resource_request WHERE MATCH(description) AGAINST ('flooded families' IN NATURAL LANGUAGE MODE));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'requests, boolean exclusion: +landslide* -rice',
    @e = (SELECT GROUP_CONCAT(request_id ORDER BY request_id) FROM resource_request WHERE description LIKE 'Napoklu: road cut off%'),
    @a = (SELECT GROUP_CONCAT(request_id ORDER BY request_id) FROM resource_request WHERE MATCH(description) AGAINST ('+landslide* -rice' IN BOOLEAN MODE));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ===========================================================================
-- Report (rows of @skipped_section print as SKIP with the gate's reason)
-- ===========================================================================
SELECT jt.n, jt.section, jt.check_name, jt.expected,
       IF(jt.section <=> @skipped_section, @skip, jt.actual) AS actual,
       IF(jt.section <=> @skipped_section, 'SKIP', jt.result) AS result
  FROM JSON_TABLE(@results, '$[*]' COLUMNS (
           n          FOR ORDINALITY,
           section    VARCHAR(20)  PATH '$[0]',
           check_name VARCHAR(80)  PATH '$[1]',
           expected   VARCHAR(160) PATH '$[2]',
           actual     VARCHAR(160) PATH '$[3]',
           result     VARCHAR(4)   PATH '$[4]')) AS jt;

SELECT 't_part2' AS file, COUNT(*) AS checks, SUM(failed) AS failures, SUM(skipped) AS skipped,
       IF(SUM(failed) = 0, 'PASS', 'FAIL') AS result
  FROM (SELECT jt.section <=> @skipped_section AS skipped,
               NOT (jt.section <=> @skipped_section) AND jt.result = 'FAIL' AS failed
          FROM JSON_TABLE(@results, '$[*]' COLUMNS (
                   section VARCHAR(20) PATH '$[0]',
                   result  VARCHAR(4)  PATH '$[4]')) AS jt) AS x;
