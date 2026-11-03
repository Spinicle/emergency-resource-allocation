-- t_seed.sql — checks on the seeded database (07_seed.sql). Run with: npm run db:test
--
-- Runs as the app user (MYSQL_USER) and writes nothing that survives (the
-- refusal checks run in a rolled-back transaction).
--
-- Part A, invariants: always run, and must hold on any database, however much
-- the app has been used since the seed.
--
-- Each check appends [section, check, expected, actual, result] to @results,
-- where result is PASS, FAIL or SKIP; db:test fails only on a FAIL cell. Same
-- pattern as t_part1.sql: the append line is repeated on purpose, never PREPAREd
-- (MySQL fixes user-variable types at PREPARE time).
--
-- Rows left by an interrupted db:race (names starting zz_) are left out wherever
-- they could change a result.

SET @results = JSON_ARRAY();

-- ===========================================================================
-- Part A: invariants
-- ===========================================================================
SET @section = 'A invariants';

SET @c = 'quantity_allocated = sum of allocations (mismatched items)', @e = 0,
    @a = (SELECT COUNT(*) FROM request_item
           WHERE quantity_allocated <> fn_item_allocated(request_item_id));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- Query 11: the ledger agrees with the stock, on every batch.
SET @c = 'q11 running SUM(change_qty) <> balance_after (rows)', @e = 0,
    @a = (SELECT COUNT(*)
            FROM (SELECT l.balance_after,
                         SUM(l.change_qty) OVER (PARTITION BY l.stock_id
                                                 ORDER BY l.changed_at, l.ledger_id) AS running
                    FROM stock_ledger l) AS x
           WHERE x.running <> x.balance_after);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'q11 last balance_after <> quantity_available (batches)', @e = 0,
    @a = (SELECT COUNT(*)
            FROM stock s
           WHERE s.quantity_available <> COALESCE((SELECT l.balance_after FROM stock_ledger l
                                                    WHERE l.stock_id = s.stock_id
                                                    ORDER BY l.changed_at DESC, l.ledger_id DESC
                                                    LIMIT 1), 0));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- The view and the function read the clock separately; within a few seconds
-- of a 6 h / 24 h deadline boundary they can legitimately differ by 2.0
-- (HANDOFF 4.4), so those rows are left out.
SET @c = 'queue score <> fn_priority_score (rows)', @e = 0,
    @a = (SELECT COUNT(*) FROM v_priority_queue
           WHERE NOT (priority_score <=> fn_priority_score(request_item_id))
             AND NOT COALESCE(ABS(TIMESTAMPDIFF(SECOND, NOW() + INTERVAL 6 HOUR, required_by)) <= 5, FALSE)
             AND NOT COALESCE(ABS(TIMESTAMPDIFF(SECOND, NOW() + INTERVAL 24 HOUR, required_by)) <= 5, FALSE));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'queue rows from a CLOSED emergency or CANCELLED request', @e = 0,
    @a = (SELECT COUNT(*) FROM v_priority_queue q
            JOIN resource_request rr ON rr.request_id = q.request_id
           WHERE q.emergency_status = 'CLOSED' OR rr.status = 'CANCELLED');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'CLOSED emergencies without end_time', @e = 0,
    @a = (SELECT COUNT(*) FROM emergency WHERE status = 'CLOSED' AND end_time IS NULL);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- Logins (HANDOFF 4.8)
SET @c = 'seeded logins present (of 7)', @e = 7,
    @a = (SELECT COUNT(*) FROM `user`
           WHERE email IN ('admin@eras.test', 'coord@eras.test', 'field1@eras.test', 'field2@eras.test',
                           'field3@eras.test', 'cm.central@eras.test', 'cm.kodagu@eras.test'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'center managers -> their centers', @e = 'Bengaluru Central Warehouse / Madikeri Relief Depot',
    @a = CONCAT_WS(' / ',
           (SELECT c.name FROM `user` u JOIN resource_center c ON c.center_id = u.center_id
             WHERE u.email = 'cm.central@eras.test'),
           (SELECT c.name FROM `user` u JOIN resource_center c ON c.center_id = u.center_id
             WHERE u.email = 'cm.kodagu@eras.test'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'users whose center_id doesn''t match their role', @e = 0,
    @a = (SELECT COUNT(*) FROM `user` u JOIN role r ON r.role_id = u.role_id
           WHERE u.email NOT LIKE 'zz\_%'
             AND (r.role_name = 'CENTER_MANAGER') <> (u.center_id IS NOT NULL));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'password hashes not bcrypt-shaped', @e = 0,
    @a = (SELECT COUNT(*) FROM `user`
           WHERE email NOT LIKE 'zz\_%'
             AND NOT (password_hash REGEXP '^[$]2[aby][$][0-9]{2}[$]' AND CHAR_LENGTH(password_hash) = 60));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ===========================================================================
-- Report
-- ===========================================================================
SELECT jt.n, jt.section, jt.check_name, jt.expected, jt.actual, jt.result
  FROM JSON_TABLE(@results, '$[*]' COLUMNS (
           n          FOR ORDINALITY,
           section    VARCHAR(20)  PATH '$[0]',
           check_name VARCHAR(80)  PATH '$[1]',
           expected   VARCHAR(160) PATH '$[2]',
           actual     VARCHAR(160) PATH '$[3]',
           result     VARCHAR(4)   PATH '$[4]')) AS jt;

SELECT 't_seed' AS file,
       JSON_LENGTH(@results) AS checks,
       (SELECT COUNT(*) FROM JSON_TABLE(@results, '$[*]' COLUMNS (r VARCHAR(4) PATH '$[4]')) AS jt
         WHERE jt.r = 'FAIL') AS failures,
       (SELECT COUNT(*) FROM JSON_TABLE(@results, '$[*]' COLUMNS (r VARCHAR(4) PATH '$[4]')) AS jt
         WHERE jt.r = 'SKIP') AS skipped,
       IF((SELECT COUNT(*) FROM JSON_TABLE(@results, '$[*]' COLUMNS (r VARCHAR(4) PATH '$[4]')) AS jt
            WHERE jt.r = 'FAIL') = 0, 'PASS', 'FAIL') AS result;
