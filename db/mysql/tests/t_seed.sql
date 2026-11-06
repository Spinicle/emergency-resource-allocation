-- t_seed.sql — checks on the seeded database (07_seed.sql). Run with: npm run db:test
--
-- Runs as the app user (MYSQL_USER) and writes nothing that survives (the
-- refusal checks run in a rolled-back transaction).
--
-- Part A, invariants: always run, and must hold on any database, however much
-- the app has been used since the seed. Only rules no legitimate app action can
-- break belong here.
-- Part B, the scenario: exact counts, logins, statuses, queue, suggestions and refusals.
-- Runs only while the database is untouched since the seed, on the seed day;
-- otherwise each row is SKIP with the reason (see Part B).
--
-- Each check appends [section, check, expected, actual, result] to @results,
-- where result is PASS, FAIL or SKIP; db:test fails only on a FAIL cell. Same
-- pattern as the t_p1_*.sql files: the append line is repeated on purpose, never PREPAREd
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

-- Only Center Managers belong to a center. (The reverse isn't an invariant:
-- deleting a center sets its managers' center_id to NULL through the FK.)
SET @c = 'users with a center_id who aren''t CENTER_MANAGER', @e = 0,
    @a = (SELECT COUNT(*) FROM `user` u JOIN role r ON r.role_id = u.role_id
           WHERE u.email NOT LIKE 'zz\_%'
             AND u.center_id IS NOT NULL AND r.role_name <> 'CENTER_MANAGER');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'password hashes not bcrypt-shaped', @e = 0,
    @a = (SELECT COUNT(*) FROM `user`
           WHERE email NOT LIKE 'zz\_%'
             AND NOT (password_hash REGEXP '^[$]2[aby][$][0-9]{2}[$]' AND CHAR_LENGTH(password_hash) = 60));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ===========================================================================
-- Part B: the seeded scenario
--
-- Exact numbers that only hold while the database is as 07_seed.sql left it,
-- on the day it ran. The seed time is the Mysuru outbreak's end_time + 14 days
-- (07_seed.sql closes it 14 days before the reset). "Untouched" means no
-- ledger row, allocation, request, observation or emergency start/end after
-- that time. Otherwise the report shows every Part B row as SKIP, with the
-- reason (the checks still run; their results are just not counted).
--
-- Status-only edits that leave no timestamp (dispatch/deliver, a request
-- cancel, admin edits) aren't detected; run db:reset before db:test after
-- using the app. Observations are checked as "at least 38" because P2.3's seed
-- adds older ones: only before each impact's second-latest seeded observation
-- and none on KDG-NAPOKLU (HANDOFF P2.3), so query 7 and the no-observation
-- queue rows don't change.
-- ===========================================================================
SET @section = 'B scenario';

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
-- Part B rows are recorded like Part A's; the report turns every row of this
-- section into SKIP, with @skip as its actual value, when the gate is shut.
SET @skipped_section = IF(@skip IS NULL, NULL, @section);

-- One row that says why Part B ran or not.
SET @c = 'scenario gate (seed untouched, same day)', @e = 'seed untouched, same day',
    @a = COALESCE(@skip, 'seed untouched, same day');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ---- row counts (zz_ rows left out) ----
SET @c = 'counts: role,user,location,emergency,impact,resource,center', @e = '4,7,15,3,10,25,5',
    @a = CONCAT_WS(',',
           (SELECT COUNT(*) FROM role),
           (SELECT COUNT(*) FROM `user` WHERE email NOT LIKE 'zz\_%'),
           (SELECT COUNT(*) FROM location WHERE grid_id NOT LIKE 'zz\_%'),
           (SELECT COUNT(*) FROM emergency WHERE name NOT LIKE 'zz\_%'),
           (SELECT COUNT(*) FROM emergency_impact ei JOIN emergency e ON e.emergency_id = ei.emergency_id
             WHERE e.name NOT LIKE 'zz\_%'),
           (SELECT COUNT(*) FROM resource WHERE name NOT LIKE 'zz\_%'),
           (SELECT COUNT(*) FROM resource_center WHERE name NOT LIKE 'zz\_%'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'counts: stock,ledger,request,item,allocation', @e = '80,115,16,44,28',
    @a = CONCAT_WS(',',
           (SELECT COUNT(*) FROM stock WHERE batch_code NOT LIKE 'zz\_%'),
           (SELECT COUNT(*) FROM stock_ledger sl JOIN stock s ON s.stock_id = sl.stock_id
             WHERE s.batch_code NOT LIKE 'zz\_%'),
           (SELECT COUNT(*) FROM resource_request rr
              JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
              JOIN emergency e         ON e.emergency_id = ei.emergency_id
             WHERE e.name NOT LIKE 'zz\_%'),
           (SELECT COUNT(*) FROM request_item ri
              JOIN resource_request rr ON rr.request_id = ri.request_id
              JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
              JOIN emergency e         ON e.emergency_id = ei.emergency_id
             WHERE e.name NOT LIKE 'zz\_%'),
           (SELECT COUNT(*) FROM allocation a JOIN stock s ON s.stock_id = a.stock_id
             WHERE s.batch_code NOT LIKE 'zz\_%'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @n = (SELECT COUNT(*) FROM impact_observation o
            JOIN emergency_impact ei ON ei.impact_id = o.impact_id
            JOIN emergency e         ON e.emergency_id = ei.emergency_id
           WHERE e.name NOT LIKE 'zz\_%');
SET @c = 'observations', @e = 'at least 38', @a = IF(@n >= 38, 'at least 38', @n);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ---- logins (HANDOFF 4.8); admins may delete or reassign users later ----
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

SET @c = 'CENTER_MANAGERs without a center', @e = 0,
    @a = (SELECT COUNT(*) FROM `user` u JOIN role r ON r.role_id = u.role_id
           WHERE u.email NOT LIKE 'zz\_%'
             AND r.role_name = 'CENTER_MANAGER' AND u.center_id IS NULL);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'inactive users', @e = 'field3@eras.test',
    @a = (SELECT GROUP_CONCAT(email ORDER BY email) FROM `user`
           WHERE NOT is_active AND email NOT LIKE 'zz\_%');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ---- every status and ledger reason ----
SET @c = 'request statuses', @e = 'CANCELLED:2,FULFILLED:4,OPEN:4,PARTIALLY_FULFILLED:6',
    @a = (SELECT GROUP_CONCAT(CONCAT(st, ':', n) ORDER BY st)
            FROM (SELECT rr.status AS st, COUNT(*) AS n
                    FROM resource_request rr
                    JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
                    JOIN emergency e         ON e.emergency_id = ei.emergency_id
                   WHERE e.name NOT LIKE 'zz\_%'
                   GROUP BY rr.status) AS x);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'item statuses', @e = 'CANCELLED:3,FULFILLED:20,PARTIAL:4,PENDING:17',
    @a = (SELECT GROUP_CONCAT(CONCAT(st, ':', n) ORDER BY st)
            FROM (SELECT ri.status AS st, COUNT(*) AS n
                    FROM request_item ri
                    JOIN resource_request rr ON rr.request_id = ri.request_id
                    JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
                    JOIN emergency e         ON e.emergency_id = ei.emergency_id
                   WHERE e.name NOT LIKE 'zz\_%'
                   GROUP BY ri.status) AS x);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'allocation statuses', @e = 'CANCELLED:2,DELIVERED:17,DISPATCHED:3,RESERVED:6',
    @a = (SELECT GROUP_CONCAT(CONCAT(st, ':', n) ORDER BY st)
            FROM (SELECT a.status AS st, COUNT(*) AS n
                    FROM allocation a JOIN stock s ON s.stock_id = a.stock_id
                   WHERE s.batch_code NOT LIKE 'zz\_%'
                   GROUP BY a.status) AS x);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'ledger reasons', @e = 'ADJUSTMENT:2,ALLOCATION:28,ALLOCATION_CANCELLED:2,RECEIPT:80,WRITE_OFF:3',
    @a = (SELECT GROUP_CONCAT(CONCAT(r, ':', n) ORDER BY r)
            FROM (SELECT sl.reason AS r, COUNT(*) AS n
                    FROM stock_ledger sl JOIN stock s ON s.stock_id = sl.stock_id
                   WHERE s.batch_code NOT LIKE 'zz\_%'
                   GROUP BY sl.reason) AS x);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ---- the queue ----
SET @c = 'queue rows', @e = 19,
    @a = (SELECT COUNT(*) FROM v_priority_queue WHERE grid_id NOT LIKE 'zz\_%');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'queue top (impact/resource/score)', @e = 'BLR-BELLANDUR/Life jacket/95.50',
    @a = (SELECT CONCAT_WS('/', grid_id, resource_name, priority_score)
            FROM v_priority_queue WHERE grid_id NOT LIKE 'zz\_%'
           ORDER BY priority_score DESC, required_by IS NULL, required_by, requested_at, request_item_id
           LIMIT 1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'queue score spread (max - min) >= 40', @e = 1,
    @a = (SELECT MAX(priority_score) - MIN(priority_score) >= 40
            FROM v_priority_queue WHERE grid_id NOT LIKE 'zz\_%');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'queue rows with no observation (Napoklu)', @e = 3,
    @a = (SELECT COUNT(*) FROM v_priority_queue
           WHERE grid_id NOT LIKE 'zz\_%' AND latest_observed_at IS NULL);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'open items left on the CLOSED emergency (not queued)', @e = 2,
    @a = (SELECT COUNT(*) FROM request_item ri
            JOIN resource_request rr ON rr.request_id = ri.request_id
            JOIN emergency_impact ei ON ei.impact_id = rr.impact_id
            JOIN emergency e         ON e.emergency_id = ei.emergency_id
           WHERE e.status = 'CLOSED' AND e.name NOT LIKE 'zz\_%'
             AND ri.status IN ('PENDING', 'PARTIAL'));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ---- stock: expiry bands and scarcity ----
SET @c = 'expiring within 7 days', @e = 'BLR-ORS-01,BLR-RTE-01,BLR-WTR-01,KSN-ORS-01,MDK-RTE-01,MDK-WTR-01,MYS-IVF-01',
    @a = (SELECT GROUP_CONCAT(batch_code ORDER BY batch_code) FROM v_expiring_stock
           WHERE batch_code NOT LIKE 'zz\_%');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'expired batches still holding stock', @e = 'BLR-INF-01,MDK-PUR-01,MYS-DNS-01,MYS-PCM-02',
    @a = (SELECT GROUP_CONCAT(batch_code ORDER BY batch_code) FROM stock
           WHERE batch_code NOT LIKE 'zz\_%' AND expiry_date < CURDATE() AND quantity_available > 0);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- Still needed in the queue vs usable at centers that aren't CLOSED.
SET @c = 'scarce: queue remaining/usable (life jackets; generators)', @e = '160.00/0.00; 6.00/3.00',
    @a = (SELECT GROUP_CONCAT(CONCAT(need, '/', usable) ORDER BY name SEPARATOR '; ')
            FROM (SELECT r.name,
                         (SELECT SUM(q.quantity_remaining) FROM v_priority_queue q
                           WHERE q.resource_id = r.resource_id AND q.grid_id NOT LIKE 'zz\_%') AS need,
                         (SELECT COALESCE(SUM(v.usable_quantity), 0) FROM v_stock_availability v
                           WHERE v.resource_id = r.resource_id AND v.center_status <> 'CLOSED') AS usable
                    FROM resource r
                   WHERE r.name IN ('Life jacket', 'Portable generator 5 kVA')) AS x);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ---- batch suggestions: FEFO inside the nearest center, nearest-short ----
SET @it_r7_rte   = (SELECT MIN(request_item_id) FROM v_priority_queue
                     WHERE grid_id = 'BLR-KORAMANGALA' AND resource_name = 'Ready-to-eat meal');
SET @it_r12_tent = (SELECT MIN(request_item_id) FROM v_priority_queue
                     WHERE grid_id = 'KDG-MADIKERI' AND resource_name = 'Family tent');
SET @it_r15_pur  = (SELECT MIN(request_item_id) FROM v_priority_queue
                     WHERE grid_id = 'KDG-NAPOKLU' AND resource_name = 'Water purification tablets');
SET @it_r5_lj    = (SELECT MIN(request_item_id) FROM v_priority_queue
                     WHERE grid_id = 'BLR-MAHADEVAPURA' AND resource_name = 'Life jacket');

SET @c = 'rank 1, Koramangala meals (expiring batch first)', @e = 'BLR-RTE-01',
    @a = (SELECT batch_code FROM v_batch_suggestions
           WHERE request_item_id = @it_r7_rte AND suggestion_rank = 1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'rank 1, Madikeri tents (nearest depot is out)', @e = 'KSN-TENT-01',
    @a = (SELECT batch_code FROM v_batch_suggestions
           WHERE request_item_id = @it_r12_tent AND suggestion_rank = 1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'rank 1, Napoklu tablets (expired batch skipped)', @e = 'KSN-PUR-01',
    @a = (SELECT batch_code FROM v_batch_suggestions
           WHERE request_item_id = @it_r15_pur AND suggestion_rank = 1);
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

SET @c = 'suggestions for life jackets', @e = 0,
    @a = (SELECT COUNT(*) FROM v_batch_suggestions s JOIN resource r ON r.resource_id = s.resource_id
           WHERE r.name = 'Life jacket');
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

-- ---- refusals (rolled back) ----
START TRANSACTION;
SET @u_coord = (SELECT user_id FROM `user` WHERE email = 'coord@eras.test');

CALL sp_test_expect(CONCAT('CALL sp_allocate(', @it_r5_lj, ', ',
                           (SELECT MIN(stock_id) FROM stock WHERE batch_code = 'WFD-LJ-01'),
                           ', 1, ', @u_coord, ', @t_seed_alloc)'), @errno, @msg);
SET @c = 'allocate from the CLOSED Whitefield camp', @e = '1644: Center Whitefield Relief Camp is CLOSED',
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));

CALL sp_test_expect(CONCAT('CALL sp_allocate(', @it_r15_pur, ', ',
                           (SELECT MIN(stock_id) FROM stock WHERE batch_code = 'MDK-PUR-01'),
                           ', 1, ', @u_coord, ', @t_seed_alloc)'), @errno, @msg);
SET @c = 'allocate from an expired batch', @e = CONCAT('1644: Batch expired on ', DATE(@seed_at) - INTERVAL 10 DAY),
    @a = CONCAT(@errno, ': ', COALESCE(@msg, ''));
SET @results = JSON_ARRAY_APPEND(@results, '$', JSON_ARRAY(@section, @c, CAST(@e AS CHAR), CAST(@a AS CHAR), IF(@a <=> @e, 'PASS', 'FAIL')));
ROLLBACK;

-- ---- query 7: impacts that got worse at their latest observation ----
SET @c = 'q7 escalating impacts', @e = 'BLR-BELLANDUR,BLR-MAHADEVAPURA,KDG-BHAGAMANDALA,KDG-MADIKERI',
    @a = (WITH ranked AS (
              SELECT o.impact_id,
                     FIELD(o.severity, 'LOW', 'MODERATE', 'HIGH', 'CRITICAL') AS sev_rank,
                     LAG(FIELD(o.severity, 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'))
                       OVER (PARTITION BY o.impact_id ORDER BY o.observed_at) AS prev_rank,
                     ROW_NUMBER() OVER (PARTITION BY o.impact_id ORDER BY o.observed_at DESC) AS rn
                FROM impact_observation o)
          SELECT GROUP_CONCAT(l.grid_id ORDER BY l.grid_id)
            FROM ranked r
            JOIN emergency_impact ei ON ei.impact_id  = r.impact_id
            JOIN location l          ON l.location_id = ei.location_id
           WHERE r.rn = 1 AND r.sev_rank > r.prev_rank AND l.grid_id NOT LIKE 'zz\_%');
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

SELECT 't_seed' AS file, COUNT(*) AS checks, SUM(failed) AS failures, SUM(skipped) AS skipped,
       IF(SUM(failed) = 0, 'PASS', 'FAIL') AS result
  FROM (SELECT jt.section <=> @skipped_section AS skipped,
               NOT (jt.section <=> @skipped_section) AND jt.result = 'FAIL' AS failed
          FROM JSON_TABLE(@results, '$[*]' COLUMNS (
                   section VARCHAR(20) PATH '$[0]',
                   result  VARCHAR(4)  PATH '$[4]')) AS jt) AS x;
