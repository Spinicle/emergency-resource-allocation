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
SET @c = 'row counts unchanged after ROLLBACK', @e = @counts_before, @a = @counts;
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ===========================================================================
-- P1.3 procedures and triggers, on a rolled-back fixture
-- ===========================================================================
-- Expected errors go through sp_test_expect (08_test_support.sql) and are
-- compared as '<errno>: <message>'; 1644 is a SIGNAL '45000' from our rules.
SET @section = 'P1.3';
EXECUTE snapshot_counts;
SET @counts_before = @counts;

START TRANSACTION;

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

-- Batches. Two go through sp_add_batch (RECEIPT by @u2; a zero batch logs nothing).
CALL sp_add_batch(@r_water, @c_near, 'zz_t13_W_NEAR', 100, CURDATE() + INTERVAL 30 DAY, @u2, @b_near);
CALL sp_add_batch(@r_water, @c_near, 'zz_t13_W_EMPTY', 0, CURDATE() + INTERVAL 30 DAY, @u2, @b_empty);
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
INSERT INTO resource_request (impact_id, user_id, requested_at) VALUES (@imp, @u1, @now - INTERVAL 1 HOUR);
SET @req5 = LAST_INSERT_ID();
INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (@req5, @r_kit, 120, 'CRITICAL');
SET @i_kit = LAST_INSERT_ID();

-- ---- Appendix A: constraints ----
CALL sp_test_expect(CONCAT('INSERT INTO stock (resource_id, center_id, batch_code, quantity_available) VALUES (',
                           @r_water, ', ', @c_near, ', ''zz_t13_NEG'', -5)'), @errno, @msg);
SET @c = 'T01 stock with quantity -5', @e = '3819: Check constraint ''chk_stock_quantity'' is violated.',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('INSERT INTO request_item (request_id, resource_id, quantity_requested, urgency) VALUES (',
                           @req3, ', ', @r_tent, ', 1, ''URGENT'')'), @errno, @msg);
SET @c = 'T02 item with urgency URGENT', @e = '3819: Check constraint ''chk_request_item_urgency'' is violated.',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

CALL sp_test_expect(CONCAT('INSERT INTO `user` (role_id, name, email, password_hash) VALUES (',
                           @role, ', ''zz_t13 copy'', ''zz_t13_alloc@eras.test'', ''x'')'), @errno, @msg);
SET @c = 'T04 two users with the same email (errno)', @e = 1062, @a = @errno;
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

-- ---- receipts ----
SET @c = 'sp_add_batch: RECEIPT by the user (reason/change/balance/by)', @e = 'RECEIPT/100.00/100.00/1',
    @a = (SELECT CONCAT_WS('/', reason, change_qty, balance_after, changed_by <=> @u2)
            FROM stock_ledger WHERE stock_id = @b_near);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

SET @c = 'a zero-quantity batch logs nothing', @e = 0,
    @a = (SELECT COUNT(*) FROM stock_ledger WHERE stock_id = @b_empty);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));

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

-- ---- T18: the ledger agrees with the stock, for every fixture batch ----
SET @c = 'T18 running SUM(change_qty) <> balance_after (rows)', @e = 0,
    @a = (SELECT COUNT(*)
            FROM (SELECT l.balance_after,
                         SUM(l.change_qty) OVER (PARTITION BY l.stock_id ORDER BY l.changed_at, l.ledger_id) AS running
                    FROM stock_ledger l
                    JOIN stock s ON s.stock_id = l.stock_id
                   WHERE s.center_id IN (@c_near, @c_ltd, @c_far, @c_shut)) AS x
           WHERE x.running <> x.balance_after);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), @a <=> @e));
SET @c = 'T18 last balance <> quantity_available (batches)', @e = 0,
    @a = (SELECT COUNT(*)
            FROM stock s
           WHERE s.center_id IN (@c_near, @c_ltd, @c_far, @c_shut)
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
           expected   VARCHAR(160) PATH '$[2]',
           actual     VARCHAR(160) PATH '$[3]',
           ok         BOOLEAN      PATH '$[4]')) AS jt;

SELECT 't_part1' AS file, JSON_LENGTH(@results) AS checks, @failures AS failures,
       IF(@failures = 0, 'PASS', 'FAIL') AS result;
