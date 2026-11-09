-- important_queries.sql
-- The 11 important queries of the ERAS report (docs/HANDOFF.md Appendix B).
-- db:reset does not run this file. `npm run db:queries` runs it as the app user
-- and fails if any result set is empty. It also runs as-is in Workbench or the
-- mysql CLI.
--
-- Each query is headed by a tag line (`Q<n>: the question`), the SQL it shows,
-- and how many rows it returns on a fresh seed on the day of the reset. Stock
-- dates are relative to the reset, so Q5 shifts at midnight.
--
-- Inputs are looked up by name, never by id. Change the SET lines to ask about
-- something else.

-- User variables take the connection's collation. Matching the database's lets
-- them be compared with its columns whichever client runs this file.
SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci;

SET @q3_grid = 'KDG-NAPOKLU', @q3_resource = 'Drinking water';
SET @q4_grid = 'BLR-BELLANDUR', @q4_resource = 'Drinking water';
SET @q9_natural = 'flooded families', @q9_boolean = '+landslide* -rice';

-- Q3's item: the highest-priority open item for that grid and resource. One
-- grid and resource can have several items, one per request.
SET @q3_item = (SELECT request_item_id
                  FROM v_priority_queue
                 WHERE grid_id = @q3_grid AND resource_name = @q3_resource
                 ORDER BY priority_score DESC, request_item_id
                 LIMIT 1);

-- Q1: Which open items should we serve first?
-- SQL: 5-table JOIN (6 with resource), ROW_NUMBER window function, fn_priority_score, ORDER BY. The same rows as v_priority_queue.
-- Expected (fresh seed, reset day): 19 rows
SELECT ri.request_item_id,
       e.name                                 AS emergency,
       l.grid_id,
       r.name                                 AS resource,
       ri.urgency,
       lo.severity                            AS latest_severity,
       ri.quantity_requested - ri.quantity_allocated AS quantity_remaining,
       rr.required_by,
       fn_priority_score(ri.request_item_id)  AS priority_score
  FROM request_item ri
  JOIN resource_request rr ON rr.request_id  = ri.request_id
  JOIN emergency_impact ei ON ei.impact_id   = rr.impact_id
  JOIN emergency e         ON e.emergency_id = ei.emergency_id
  JOIN location l          ON l.location_id  = ei.location_id
  JOIN resource r          ON r.resource_id  = ri.resource_id
  LEFT JOIN (SELECT o.impact_id,
                    o.severity,
                    ROW_NUMBER() OVER (PARTITION BY o.impact_id ORDER BY o.observed_at DESC) AS rn
               FROM impact_observation o) lo
         ON lo.impact_id = ei.impact_id AND lo.rn = 1
 WHERE ri.status IN ('PENDING', 'PARTIAL')
   AND rr.status <> 'CANCELLED'
   AND e.status <> 'CLOSED'
 ORDER BY priority_score DESC, rr.required_by IS NULL, rr.required_by, rr.requested_at, ri.request_item_id;

-- Q2: How much of each resource is unmet per emergency?
-- SQL: LEFT JOIN to allocations pre-aggregated per item (so nothing fans out), GROUP BY, HAVING unmet > 0.
-- Expected (fresh seed, reset day): 20 rows
SELECT e.name                                               AS emergency,
       r.name                                               AS resource,
       r.unit,
       SUM(ri.quantity_requested)                           AS requested,
       SUM(COALESCE(al.qty, 0))                             AS allocated,
       SUM(ri.quantity_requested - COALESCE(al.qty, 0))     AS unmet
  FROM request_item ri
  JOIN resource_request rr ON rr.request_id  = ri.request_id
  JOIN emergency_impact ei ON ei.impact_id   = rr.impact_id
  JOIN emergency e         ON e.emergency_id = ei.emergency_id
  JOIN resource r          ON r.resource_id  = ri.resource_id
  LEFT JOIN (SELECT a.request_item_id, SUM(a.quantity_allocated) AS qty
               FROM allocation a
              WHERE a.status <> 'CANCELLED'
              GROUP BY a.request_item_id) al
         ON al.request_item_id = ri.request_item_id
 WHERE ri.status <> 'CANCELLED'
   AND rr.status <> 'CANCELLED'
 GROUP BY e.emergency_id, e.name, r.resource_id, r.name, r.unit
HAVING unmet > 0
 ORDER BY e.name, unmet DESC, r.name;

-- Q3: Which centers can cover this item in full?
-- SQL: GROUP BY center, HAVING SUM >= a correlated subquery on the grouped resource.
-- Expected (fresh seed, reset day): 4 rows
SELECT c.center_id,
       c.name                    AS center,
       c.status                  AS center_status,
       SUM(s.quantity_available) AS usable_quantity
  FROM stock s
  JOIN resource_center c ON c.center_id = s.center_id
 WHERE s.resource_id = (SELECT resource_id FROM request_item WHERE request_item_id = @q3_item)
   AND s.quantity_available > 0
   AND (s.expiry_date IS NULL OR s.expiry_date >= CURDATE())
   AND c.status IN ('OPERATIONAL', 'LIMITED')
 GROUP BY c.center_id, c.name, c.status, s.resource_id
HAVING usable_quantity >= (SELECT ri.quantity_requested - ri.quantity_allocated
                             FROM request_item ri
                            WHERE ri.request_item_id = @q3_item
                              AND ri.resource_id = s.resource_id)
 ORDER BY usable_quantity DESC, c.name;

-- Q4: Which centers nearest this impact hold this resource?
-- SQL: fn_distance_km, ORDER BY distance, LIMIT 5.
-- Expected (fresh seed, reset day): 4 rows
SELECT c.name                                                                AS center,
       c.status                                                              AS center_status,
       SUM(s.quantity_available)                                             AS usable_quantity,
       fn_distance_km(il.latitude, il.longitude, cl.latitude, cl.longitude)  AS distance_km
  FROM stock s
  JOIN resource r        ON r.resource_id = s.resource_id
  JOIN resource_center c ON c.center_id   = s.center_id
  JOIN location cl       ON cl.location_id = c.location_id
  JOIN location il       ON il.grid_id     = @q4_grid
 WHERE r.name = @q4_resource
   AND c.status IN ('OPERATIONAL', 'LIMITED')
   AND s.quantity_available > 0
   AND (s.expiry_date IS NULL OR s.expiry_date >= CURDATE())
 GROUP BY c.center_id, c.name, c.status, il.latitude, il.longitude, cl.latitude, cl.longitude
 ORDER BY distance_km
 LIMIT 5;

-- Q5: What expires in the next 7 days?
-- SQL: date arithmetic (DATEDIFF, CURDATE() + INTERVAL), JOIN. The same rows as v_expiring_stock.
-- Expected (fresh seed, reset day): 7 rows
SELECT s.batch_code,
       r.name                              AS resource,
       c.name                              AS center,
       s.quantity_available,
       r.unit,
       s.expiry_date,
       DATEDIFF(s.expiry_date, CURDATE())  AS days_left
  FROM stock s
  JOIN resource r        ON r.resource_id = s.resource_id
  JOIN resource_center c ON c.center_id   = s.center_id
 WHERE s.quantity_available > 0
   AND s.expiry_date BETWEEN CURDATE() AND CURDATE() + INTERVAL 7 DAY
 ORDER BY days_left, s.batch_code;

-- Q6: What is the fulfilment rate per emergency?
-- SQL: SUM/COUNT ratios, NULLIF against dividing by zero, ORDER BY. item_rate_pct counts whole items; quantity_rate_pct averages each item's served share, so units aren't added together.
-- Expected (fresh seed, reset day): 3 rows
SELECT e.name                                                           AS emergency,
       e.status                                                         AS emergency_status,
       COUNT(i.request_item_id)                                         AS items,
       COUNT(CASE WHEN i.status = 'FULFILLED' THEN 1 END)               AS fulfilled,
       ROUND(100 * COUNT(CASE WHEN i.status = 'FULFILLED' THEN 1 END)
                 / NULLIF(COUNT(i.request_item_id), 0), 2)              AS item_rate_pct,
       ROUND(100 * SUM(i.allocated / i.quantity_requested)
                 / NULLIF(COUNT(i.request_item_id), 0), 2)              AS quantity_rate_pct
  FROM emergency e
  LEFT JOIN (SELECT ei.emergency_id,
                    ri.request_item_id,
                    ri.status,
                    ri.quantity_requested,
                    COALESCE(al.qty, 0) AS allocated
               FROM request_item ri
               JOIN resource_request rr ON rr.request_id = ri.request_id
               JOIN emergency_impact ei ON ei.impact_id  = rr.impact_id
               LEFT JOIN (SELECT a.request_item_id, SUM(a.quantity_allocated) AS qty
                            FROM allocation a
                           WHERE a.status <> 'CANCELLED'
                           GROUP BY a.request_item_id) al
                      ON al.request_item_id = ri.request_item_id
              WHERE ri.status <> 'CANCELLED'
                AND rr.status <> 'CANCELLED') i
         ON i.emergency_id = e.emergency_id
 GROUP BY e.emergency_id, e.name, e.status
 ORDER BY item_rate_pct DESC, e.name;

-- Q7: Which impacts are getting worse?
-- SQL: CTE, LAG, ROW_NUMBER.
-- Expected (fresh seed, reset day): 4 rows
WITH ranked AS (
  SELECT o.impact_id, o.observed_at, o.severity,
         FIELD(o.severity,'LOW','MODERATE','HIGH','CRITICAL') AS sev_rank,
         LAG(FIELD(o.severity,'LOW','MODERATE','HIGH','CRITICAL'))
           OVER (PARTITION BY o.impact_id ORDER BY o.observed_at)        AS prev_rank,
         ROW_NUMBER() OVER (PARTITION BY o.impact_id ORDER BY o.observed_at DESC) AS rn
  FROM impact_observation o
)
SELECT e.name AS emergency, l.grid_id, r.severity, r.observed_at
FROM ranked r
JOIN emergency_impact ei ON ei.impact_id   = r.impact_id
JOIN emergency e         ON e.emergency_id = ei.emergency_id
JOIN location l          ON l.location_id  = ei.location_id
WHERE r.rn = 1 AND r.sev_rank > r.prev_rank
ORDER BY r.sev_rank DESC, r.observed_at DESC;

-- Q8: Which resources were never requested in an emergency?
-- SQL: emergency x resource (CROSS JOIN), NOT EXISTS against that emergency's non-cancelled items.
-- Expected (fresh seed, reset day): 37 rows (Bengaluru Urban Flood 7, Kodagu Landslide 11, Mysuru Dengue Outbreak 19)
SELECT e.name AS emergency,
       r.name AS resource,
       r.category
  FROM emergency e
 CROSS JOIN resource r
 WHERE NOT EXISTS (SELECT 1
                     FROM request_item ri
                     JOIN resource_request rr ON rr.request_id = ri.request_id
                     JOIN emergency_impact ei ON ei.impact_id  = rr.impact_id
                    WHERE ei.emergency_id = e.emergency_id
                      AND ri.resource_id  = r.resource_id
                      AND ri.status <> 'CANCELLED'
                      AND rr.status <> 'CANCELLED')
 ORDER BY e.name, r.name;

-- Q8b: Which resources were never requested in any emergency?
-- SQL: NOT EXISTS.
-- Expected (fresh seed, reset day): 4 rows
SELECT r.name AS resource,
       r.category,
       r.unit
  FROM resource r
 WHERE NOT EXISTS (SELECT 1 FROM request_item ri WHERE ri.resource_id = r.resource_id)
 ORDER BY r.name;

-- Q9a: Search requests by text (natural language mode)
-- SQL: MATCH ... AGAINST in natural language mode on ftx_request_desc, ranked by relevance.
-- Expected (fresh seed, reset day): 5 rows
SELECT rr.request_id,
       rr.status,
       LEFT(rr.description, 80)                                                 AS description,
       MATCH(rr.description) AGAINST (@q9_natural IN NATURAL LANGUAGE MODE)     AS relevance
  FROM resource_request rr
 WHERE MATCH(rr.description) AGAINST (@q9_natural IN NATURAL LANGUAGE MODE)
 ORDER BY relevance DESC, rr.request_id;

-- Q9b: Search requests by text (boolean mode)
-- SQL: MATCH ... AGAINST in boolean mode on ftx_request_desc: required word with prefix match, excluded word.
-- Expected (fresh seed, reset day): 1 row
SELECT rr.request_id,
       rr.status,
       LEFT(rr.description, 80) AS description
  FROM resource_request rr
 WHERE MATCH(rr.description) AGAINST (@q9_boolean IN BOOLEAN MODE)
 ORDER BY rr.request_id;

-- Q10: Who are the most active field officers?
-- SQL: GROUP BY, COUNT, ORDER BY, LIMIT.
-- Expected (fresh seed, reset day): 3 rows
SELECT u.name,
       u.email,
       u.is_active,
       COUNT(*) AS observations
  FROM impact_observation o
  JOIN `user` u ON u.user_id = o.user_id
  JOIN role r   ON r.role_id = u.role_id
 WHERE r.role_name = 'FIELD_OFFICER'
 GROUP BY u.user_id, u.name, u.email, u.is_active
 ORDER BY observations DESC, u.name
 LIMIT 5;

-- Q11a: Does the ledger agree with the stock, batch by batch?
-- SQL: running SUM(change_qty) OVER (PARTITION BY stock_id ORDER BY changed_at, ledger_id) vs balance_after, and the last balance_after vs quantity_available. The ledger_id tie-break matters: many rows share a second.
-- Expected (fresh seed, reset day): 80 rows, every status OK
WITH running AS (
    SELECT l.stock_id,
           l.balance_after,
           SUM(l.change_qty) OVER (PARTITION BY l.stock_id ORDER BY l.changed_at, l.ledger_id) AS running_total,
           ROW_NUMBER() OVER (PARTITION BY l.stock_id ORDER BY l.changed_at DESC, l.ledger_id DESC) AS rn
      FROM stock_ledger l
),
per_batch AS (
    SELECT stock_id,
           COUNT(*)                                   AS ledger_rows,
           SUM(running_total <> balance_after)        AS running_mismatches,
           MAX(CASE WHEN rn = 1 THEN balance_after END) AS last_balance
      FROM running
     GROUP BY stock_id
)
SELECT s.stock_id,
       s.batch_code,
       r.name                                        AS resource,
       s.quantity_available,
       COALESCE(b.ledger_rows, 0)                    AS ledger_rows,
       COALESCE(b.running_mismatches, 0)             AS running_mismatches,
       COALESCE(b.last_balance, 0)                   AS last_balance,
       COALESCE(b.last_balance, 0) = s.quantity_available AS last_balance_ok,
       IF(COALESCE(b.running_mismatches, 0) = 0
          AND COALESCE(b.last_balance, 0) = s.quantity_available, 'OK', 'MISMATCH') AS status
  FROM stock s
  JOIN resource r ON r.resource_id = s.resource_id
  LEFT JOIN per_batch b ON b.stock_id = s.stock_id
 ORDER BY s.stock_id;

-- Q11b: Does the ledger agree with the stock overall?
-- SQL: the same CTEs, summed. mismatched_batches must be 0.
-- Expected (fresh seed, reset day): 1 row, 80 batches checked, 0 mismatched
WITH running AS (
    SELECT l.stock_id,
           l.balance_after,
           SUM(l.change_qty) OVER (PARTITION BY l.stock_id ORDER BY l.changed_at, l.ledger_id) AS running_total,
           ROW_NUMBER() OVER (PARTITION BY l.stock_id ORDER BY l.changed_at DESC, l.ledger_id DESC) AS rn
      FROM stock_ledger l
),
per_batch AS (
    SELECT stock_id,
           SUM(running_total <> balance_after)          AS running_mismatches,
           MAX(CASE WHEN rn = 1 THEN balance_after END) AS last_balance
      FROM running
     GROUP BY stock_id
)
SELECT COUNT(*)                                                          AS batches_checked,
       COUNT(CASE WHEN COALESCE(b.running_mismatches, 0) > 0 THEN 1 END) AS running_total_mismatches,
       COUNT(CASE WHEN COALESCE(b.last_balance, 0) <> s.quantity_available THEN 1 END) AS last_balance_mismatches,
       COUNT(CASE WHEN COALESCE(b.running_mismatches, 0) > 0
                    OR COALESCE(b.last_balance, 0) <> s.quantity_available THEN 1 END) AS mismatched_batches
  FROM stock s
  LEFT JOIN per_batch b ON b.stock_id = s.stock_id;
