-- t_part1.sql — Part 1 database tests. Run with: npm run db:test
--
-- Runs as the app user (MYSQL_USER), so it also proves the app's privileges
-- (EXECUTE on the functions, SELECT on the INVOKER views).
--
-- Safe on an empty or a seeded database:
--   * the fixture only adds rows: roles are looked up by name and inserted only
--     if missing; every UNIQUE value starts with zz_t12_
--   * every assertion is limited to the fixture's own ids
--   * the fixture is rolled back, and row counts are checked before and after
--
-- Each check appends [section, check, expected, actual, ok] to @results, a JSON
-- array in a user variable (the app user can't create temporary tables). The file
-- ends by printing one row per check (PASS/FAIL) and a summary with @failures.
--
-- Check pattern:
--   SET @c = '<check>', @e = <expected>, @a = <actual>;
--   SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
-- The second line is repeated on purpose. Don't turn it into a PREPAREd statement:
-- MySQL fixes user-variable types at PREPARE time, so @a <=> @e would compare
-- every check as the first check's type (e.g. 'abc' <=> 'abd' is true as DECIMAL).

SET @results = JSON_ARRAY();

-- ===========================================================================
-- P1.2 functions, against a fixed clock (no data needed)
-- ===========================================================================
SET @section = 'P1.2 fn';
SET @t = TIMESTAMP('2026-11-10 12:00:00');

-- fn_deadline_pressure: <= 6 h (incl. overdue) 1, <= 24 h 0.6, later 0.2, none 0
SET @c = 'deadline 1 h overdue', @e = 1.00, @a = fn_deadline_pressure(@t - INTERVAL 1 HOUR, @t);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'deadline in 6 h', @e = 1.00, @a = fn_deadline_pressure(@t + INTERVAL 6 HOUR, @t);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'deadline in 6 h 1 min', @e = 0.60, @a = fn_deadline_pressure(@t + INTERVAL 361 MINUTE, @t);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'deadline in 24 h', @e = 0.60, @a = fn_deadline_pressure(@t + INTERVAL 24 HOUR, @t);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'deadline in 24 h 1 min', @e = 0.20, @a = fn_deadline_pressure(@t + INTERVAL 1441 MINUTE, @t);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'deadline NULL', @e = 0.00, @a = fn_deadline_pressure(NULL, @t);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'deadline with no clock', @e = NULL, @a = fn_deadline_pressure(@t, NULL);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- fn_wait_pressure: hours waiting / 48, clamped to [0, 1]
SET @c = 'wait, requested 1 h in the future', @e = 0.0000, @a = fn_wait_pressure(@t + INTERVAL 1 HOUR, @t);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'wait 24 h', @e = 0.5000, @a = fn_wait_pressure(@t - INTERVAL 24 HOUR, @t);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'wait 48 h', @e = 1.0000, @a = fn_wait_pressure(@t - INTERVAL 48 HOUR, @t);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'wait 72 h (capped)', @e = 1.0000, @a = fn_wait_pressure(@t - INTERVAL 72 HOUR, @t);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- fn_level_weight
SET @c = 'weight LOW', @e = 0.25, @a = fn_level_weight('LOW');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'weight MEDIUM', @e = 0.50, @a = fn_level_weight('MEDIUM');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'weight MODERATE', @e = 0.50, @a = fn_level_weight('MODERATE');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'weight HIGH', @e = 0.75, @a = fn_level_weight('HIGH');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'weight CRITICAL', @e = 1.00, @a = fn_level_weight('CRITICAL');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'weight NULL', @e = NULL, @a = fn_level_weight(NULL);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'weight BOGUS', @e = 0.00, @a = fn_level_weight('BOGUS');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- fn_priority_from_parts
SET @c = 'from_parts(1, .75, .4, .5, 1)', @e = 78.50, @a = fn_priority_from_parts(1, 0.75, 0.4, 0.5, 1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'from_parts with a NULL part', @e = NULL, @a = fn_priority_from_parts(1, NULL, 0.4, 0.5, 1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- fn_distance_km: Bengaluru -> Madikeri is about 210 km
SET @d = fn_distance_km(12.9716, 77.5946, 12.4244, 75.7382);
SET @c = 'distance Bengaluru-Madikeri', @e = 'in [209, 212]',
    @a = IF(@d BETWEEN 209 AND 212, 'in [209, 212]', CAST(@d AS CHAR));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'distance is symmetric', @e = @d, @a = fn_distance_km(12.4244, 75.7382, 12.9716, 77.5946);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'distance to the same point', @e = 0.000, @a = fn_distance_km(12.9716, 77.5946, 12.9716, 77.5946);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- fn_priority_score on an id that doesn't exist
SET @c = 'score of a missing item', @e = NULL, @a = fn_priority_score(-1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ===========================================================================
-- P1.2 views, on a rolled-back fixture
-- ===========================================================================
SET @section = 'P1.2 views';

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
EXECUTE snapshot_counts;
SET @counts_before = @counts;

START TRANSACTION;
SET @now = NOW();

-- Role (seed may already have it) and one user
INSERT INTO role (role_name)
SELECT 'COORDINATOR' FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM role WHERE role_name = 'COORDINATOR');
SET @role = (SELECT role_id FROM role WHERE role_name = 'COORDINATOR');
INSERT INTO `user` (role_id, name, email, password_hash)
VALUES (@role, 'zz_t12 coordinator', 'zz_t12_coord@eras.test', 'not-a-real-hash');
SET @user = LAST_INSERT_ID();

-- Locations: 4 impacts, 2 centers
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t12_g_obs', 12.9352000, 77.6245000);
SET @loc_obs = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t12_g_none', 12.9716000, 77.5946000);
SET @loc_none = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t12_g_closed', 12.4244000, 75.7382000);
SET @loc_closed = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t12_g_resolved', 12.3375000, 75.8069000);
SET @loc_resolved = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t12_g_main', 12.9784000, 77.5730000);
SET @loc_main = LAST_INSERT_ID();
INSERT INTO location (grid_id, latitude, longitude) VALUES ('zz_t12_g_ltd', 12.4210000, 75.7390000);
SET @loc_ltd = LAST_INSERT_ID();

-- Emergencies: ACTIVE, CLOSED (excluded from the queue), CONTAINED (kept)
INSERT INTO emergency (name, type, start_time, status)
VALUES ('zz_t12 active flood', 'FLOOD', @now - INTERVAL 3 DAY, 'ACTIVE');
SET @em_active = LAST_INSERT_ID();
INSERT INTO emergency (name, type, start_time, end_time, status)
VALUES ('zz_t12 closed fire', 'FIRE', @now - INTERVAL 10 DAY, @now - INTERVAL 5 DAY, 'CLOSED');
SET @em_closed = LAST_INSERT_ID();
INSERT INTO emergency (name, type, start_time, status)
VALUES ('zz_t12 contained landslide', 'LANDSLIDE', @now - INTERVAL 5 DAY, 'CONTAINED');
SET @em_contained = LAST_INSERT_ID();

-- Impacts
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@em_active, @loc_obs, 'ACTIVE');
SET @imp_obs = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@em_active, @loc_none, 'ACTIVE');
SET @imp_none = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@em_closed, @loc_closed, 'RESOLVED');
SET @imp_closed = LAST_INSERT_ID();
INSERT INTO emergency_impact (emergency_id, location_id, status) VALUES (@em_contained, @loc_resolved, 'RESOLVED');
SET @imp_resolved = LAST_INSERT_ID();

-- Two observations on @imp_obs; the later one (HIGH, 40%) must win. None on @imp_none.
INSERT INTO impact_observation (impact_id, user_id, observed_at, affected_percentage, severity)
VALUES (@imp_obs, @user, @now - INTERVAL 10 HOUR, 10.00, 'MODERATE'),
       (@imp_obs, @user, @now - INTERVAL 2 HOUR, 40.00, 'HIGH');

-- Resources
INSERT INTO resource (name, category, unit) VALUES ('zz_t12 water', 'WATER', 'L');
SET @res_water = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t12 rations', 'FOOD', 'packs');
SET @res_food = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t12 med kit', 'MEDICAL', 'kits');
SET @res_med = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t12 tarpaulin', 'SHELTER', 'sheets');
SET @res_tarp = LAST_INSERT_ID();
INSERT INTO resource (name, category, unit) VALUES ('zz_t12 soap', 'HYGIENE', 'bars');
SET @res_soap = LAST_INSERT_ID();

-- Centers
INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@loc_main, 'zz_t12 main warehouse', 'WAREHOUSE', 'OPERATIONAL');
SET @c_main = LAST_INSERT_ID();
INSERT INTO resource_center (location_id, name, center_type, status)
VALUES (@loc_ltd, 'zz_t12 limited depot', 'DEPOT', 'LIMITED');
SET @c_ltd = LAST_INSERT_ID();

-- Water at the main warehouse: one batch of every kind.
-- Usable: today 20 + 3 d 30 + 10 d 40 + no expiry 50 = 140 in 4 batches.
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date) VALUES
    (@res_water, @c_main, 'zz_t12_W_EXPIRED', 10, CURDATE() - INTERVAL 1 DAY),
    (@res_water, @c_main, 'zz_t12_W_TODAY',   20, CURDATE()),
    (@res_water, @c_main, 'zz_t12_W_3D',      30, CURDATE() + INTERVAL 3 DAY),
    (@res_water, @c_main, 'zz_t12_W_10D',     40, CURDATE() + INTERVAL 10 DAY),
    (@res_water, @c_main, 'zz_t12_W_NOEXP',   50, NULL),
    (@res_water, @c_main, 'zz_t12_W_EMPTY',    0, CURDATE() + INTERVAL 5 DAY);
-- Rations at the main warehouse, used by the PARTIAL item's allocations.
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
VALUES (@res_food, @c_main, 'zz_t12_F_10D', 100, CURDATE() + INTERVAL 10 DAY);
SET @stock_food = LAST_INSERT_ID();
-- Med kits at the limited depot: the pair's only batch is expired.
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
VALUES (@res_med, @c_ltd, 'zz_t12_M_EXPIRED', 25, CURDATE() - INTERVAL 2 DAY);
-- Med kits at the main warehouse, used up by the FULFILLED item.
INSERT INTO stock (resource_id, center_id, batch_code, quantity_available, expiry_date)
VALUES (@res_med, @c_main, 'zz_t12_M_MAIN', 10, NULL);
SET @stock_med = LAST_INSERT_ID();

-- Request with an observed impact: waited 24 h, due in 3 h (well inside D's 6 h band).
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@imp_obs, @user, @now - INTERVAL 24 HOUR, @now + INTERVAL 3 HOUR, 'zz_t12 main');
SET @req_main = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency)
VALUES (@req_main, @res_water, 100, 'CRITICAL');
SET @it_crit = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency)
VALUES (@req_main, @res_food, 100, 'HIGH');
SET @it_partial = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency)
VALUES (@req_main, @res_med, 10, 'LOW');
SET @it_done = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency)
VALUES (@req_main, @res_tarp, 5, 'MEDIUM');
SET @it_cancel = LAST_INSERT_ID();
-- Statuses come from the triggers (P1.3). PARTIAL: 30 stays RESERVED, 50 is
-- cancelled (food 100 -> 70). FULFILLED: all 10 med kits. CANCELLED: by hand,
-- allowed because it has no allocations.
CALL sp_allocate(@it_partial, @stock_food, 30, @user, @alloc_keep);
CALL sp_allocate(@it_partial, @stock_food, 50, @user, @alloc_undo);
CALL sp_cancel_allocation(@alloc_undo, @user);
CALL sp_allocate(@it_done, @stock_med, 10, @user, @alloc_done);
UPDATE request_item SET status = 'CANCELLED' WHERE request_item_id = @it_cancel;

-- Request on an impact with no observations, just made, no deadline.
INSERT INTO resource_request (impact_id, user_id, requested_at, required_by, description)
VALUES (@imp_none, @user, @now, NULL, 'zz_t12 no observation');
SET @req_noobs = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency)
VALUES (@req_noobs, @res_water, 50, 'MEDIUM');
SET @it_noobs = LAST_INSERT_ID();

-- Cancelled request: cancelling its only item rolls the request up to CANCELLED;
-- the item is excluded.
INSERT INTO resource_request (impact_id, user_id, requested_at, description)
VALUES (@imp_obs, @user, @now - INTERVAL 1 HOUR, 'zz_t12 cancelled');
SET @req_cancelled = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency)
VALUES (@req_cancelled, @res_water, 5, 'HIGH');
SET @it_in_cancelled = LAST_INSERT_ID();
UPDATE request_item SET status = 'CANCELLED' WHERE request_item_id = @it_in_cancelled;

-- Request in a CLOSED emergency: excluded.
INSERT INTO resource_request (impact_id, user_id, requested_at, description)
VALUES (@imp_closed, @user, @now - INTERVAL 6 DAY, 'zz_t12 closed emergency');
SET @req_closed = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency)
VALUES (@req_closed, @res_water, 5, 'HIGH');
SET @it_closed = LAST_INSERT_ID();

-- Request in a CONTAINED emergency on a RESOLVED impact: kept.
INSERT INTO resource_request (impact_id, user_id, requested_at, description)
VALUES (@imp_resolved, @user, @now - INTERVAL 1 HOUR, 'zz_t12 contained emergency');
SET @req_contained = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency)
VALUES (@req_contained, @res_soap, 20, 'LOW');
SET @it_contained = LAST_INSERT_ID();

SET @fixture_items = CONCAT_WS(',', @it_crit, @it_partial, @it_done, @it_cancel,
                               @it_noobs, @it_in_cancelled, @it_closed, @it_contained);

-- ---- v_priority_queue ----
SET @c = 'queue holds exactly the expected fixture items',
    @e = CONCAT_WS(',', @it_crit, @it_partial, @it_noobs, @it_contained),
    @a = (SELECT GROUP_CONCAT(request_item_id ORDER BY request_item_id)
            FROM v_priority_queue WHERE FIND_IN_SET(request_item_id, @fixture_items));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'queue has no duplicate rows', @e = 0,
    @a = (SELECT COUNT(*) - COUNT(DISTINCT request_item_id)
            FROM v_priority_queue WHERE FIND_IN_SET(request_item_id, @fixture_items));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'CONTAINED/RESOLVED item kept, with statuses', @e = 'CONTAINED/RESOLVED',
    @a = (SELECT CONCAT(emergency_status, '/', impact_status)
            FROM v_priority_queue WHERE request_item_id = @it_contained);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'PARTIAL item: status/allocated/remaining', @e = 'PARTIAL/30.00/70.00',
    @a = (SELECT CONCAT_WS('/', item_status, quantity_allocated, quantity_remaining)
            FROM v_priority_queue WHERE request_item_id = @it_partial);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'latest observation wins', @e = 'HIGH/40.00',
    @a = (SELECT CONCAT_WS('/', latest_severity, latest_affected_pct)
            FROM v_priority_queue WHERE request_item_id = @it_crit);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'CRITICAL item parts u/s/a/d', @e = '1.00/0.75/0.4000/1.00',
    @a = (SELECT CONCAT_WS('/', u_part, s_part, a_part, d_part)
            FROM v_priority_queue WHERE request_item_id = @it_crit);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'CRITICAL, HIGH 40%, waited 24 h, due in 3 h', @e = 78.50,
    @a = (SELECT priority_score FROM v_priority_queue WHERE request_item_id = @it_crit);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'no observation: severity/s/a/hours', @e = 'NULL/0.50/0.0000/0.0',
    @a = (SELECT CONCAT_WS('/', COALESCE(latest_severity, 'NULL'), s_part, a_part, hours_waiting)
            FROM v_priority_queue WHERE request_item_id = @it_noobs);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'MEDIUM, no observation, new, no deadline', @e = 35.00,
    @a = (SELECT priority_score FROM v_priority_queue WHERE request_item_id = @it_noobs);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'rows with a part outside [0,1], score outside [0,100] or hours < 0', @e = 0,
    @a = (SELECT COUNT(*) FROM v_priority_queue
           WHERE FIND_IN_SET(request_item_id, @fixture_items)
             AND NOT (    COALESCE(u_part BETWEEN 0 AND 1, FALSE)
                      AND COALESCE(s_part BETWEEN 0 AND 1, FALSE)
                      AND COALESCE(a_part BETWEEN 0 AND 1, FALSE)
                      AND COALESCE(w_part BETWEEN 0 AND 1, FALSE)
                      AND COALESCE(d_part BETWEEN 0 AND 1, FALSE)
                      AND COALESCE(priority_score BETWEEN 0 AND 100, FALSE)
                      AND COALESCE(hours_waiting >= 0, FALSE)));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'rows where priority_score <> fn_priority_score(item)', @e = 0,
    @a = (SELECT COUNT(*) FROM v_priority_queue
           WHERE FIND_IN_SET(request_item_id, @fixture_items)
             AND NOT (priority_score <=> fn_priority_score(request_item_id)));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ---- v_stock_availability ----
SET @c = 'availability rows for fixture centers', @e = 4,
    @a = (SELECT COUNT(*) FROM v_stock_availability WHERE center_id IN (@c_main, @c_ltd));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'water at main: usable qty/batches/earliest', @e = CONCAT_WS('/', '140.00', 4, CURDATE()),
    @a = (SELECT CONCAT_WS('/', usable_quantity, usable_batches, earliest_usable_expiry)
            FROM v_stock_availability WHERE resource_id = @res_water AND center_id = @c_main);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'expired-only pair: qty/batches/earliest (0, not NULL)', @e = '0.00/0/NULL',
    @a = (SELECT CONCAT_WS('/', COALESCE(usable_quantity, 'NULL'), COALESCE(usable_batches, 'NULL'),
                           COALESCE(earliest_usable_expiry, 'NULL'))
            FROM v_stock_availability WHERE resource_id = @res_med AND center_id = @c_ltd);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'expired-only pair: center status', @e = 'LIMITED',
    @a = (SELECT center_status FROM v_stock_availability WHERE resource_id = @res_med AND center_id = @c_ltd);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ---- v_expiring_stock ----
SET @c = 'expiring batches (code:days_left)', @e = 'zz_t12_W_TODAY:0,zz_t12_W_3D:3',
    @a = (SELECT GROUP_CONCAT(CONCAT(batch_code, ':', days_left) ORDER BY days_left, batch_code)
            FROM v_expiring_stock WHERE center_id IN (@c_main, @c_ltd));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

ROLLBACK;

-- ---- after rollback ----
EXECUTE snapshot_counts;
DEALLOCATE PREPARE snapshot_counts;
SET @c = 'row counts unchanged after ROLLBACK', @e = @counts_before, @a = @counts;
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ===========================================================================
-- Report
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
           expected   VARCHAR(100) PATH '$[2]',
           actual     VARCHAR(100) PATH '$[3]',
           ok         BOOLEAN      PATH '$[4]')) AS jt;

SELECT 't_part1' AS file, JSON_LENGTH(@results) AS checks, @failures AS failures,
       IF(@failures = 0, 'PASS', 'FAIL') AS result;
