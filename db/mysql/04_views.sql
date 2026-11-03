-- 04_views.sql
-- Read models for allocation and stock (docs/HANDOFF.md 4.4).
--
-- All views run with the caller's privileges (SQL SECURITY INVOKER) and have no
-- ORDER BY; consumers order them. Every NOW() / CURDATE() inside one query
-- returns the same value, so all rows of a result share one clock.
--
-- "Usable" batch, used here and by P1.3 (trg_allocation_bi, sp_suggest_batches):
--   quantity_available > 0 AND (expiry_date IS NULL OR expiry_date >= CURDATE())
-- A batch expiring today is still usable; "expired" means expiry_date < CURDATE().

-- ---------------------------------------------------------------------------
-- v_priority_queue: one row per open request item, with its score and parts.
--
-- Rows: items PENDING or PARTIAL whose request isn't CANCELLED and whose
-- emergency isn't CLOSED. Items under a CONTAINED emergency or a RESOLVED
-- impact stay in; emergency_status / impact_status let /allocate badge them.
--
-- Order for the queue:
--   priority_score DESC, required_by IS NULL, required_by, requested_at, request_item_id
--
-- Parts are 0–1 (u, s, d to 2 dp; a, w to 4 dp). No observation for the impact:
-- s_part 0.5, a_part 0. quantity_allocated counts every allocation that isn't
-- CANCELLED (RESERVED, DISPATCHED, DELIVERED).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE
    SQL SECURITY INVOKER
    VIEW v_priority_queue AS
WITH latest_obs AS (
    -- Latest observation per impact (uq_impact_observation_time rules out ties).
    SELECT o.impact_id,
           o.severity,
           o.affected_percentage,
           o.observed_at,
           ROW_NUMBER() OVER (PARTITION BY o.impact_id ORDER BY o.observed_at DESC) AS rn
      FROM impact_observation o
),
alloc AS (
    -- One row per item, so joining it can't multiply queue rows.
    SELECT a.request_item_id,
           SUM(a.quantity_allocated) AS qty
      FROM allocation a
     WHERE a.status <> 'CANCELLED'
     GROUP BY a.request_item_id
),
base AS (
    SELECT ri.request_item_id,
           ri.request_id,
           ri.status                                        AS item_status,
           e.emergency_id,
           e.name                                           AS emergency_name,
           e.status                                         AS emergency_status,
           ei.impact_id,
           ei.status                                        AS impact_status,
           l.grid_id,
           l.latitude,
           l.longitude,
           r.resource_id,
           r.name                                           AS resource_name,
           r.unit,
           ri.quantity_requested,
           COALESCE(al.qty, 0)                              AS quantity_allocated,
           GREATEST(ri.quantity_requested - COALESCE(al.qty, 0), 0) AS quantity_remaining,
           ri.urgency,
           lo.severity                                      AS latest_severity,
           lo.affected_percentage                           AS latest_affected_pct,
           lo.observed_at                                   AS latest_observed_at,
           rr.requested_at,
           rr.required_by,
           ROUND(GREATEST(0, TIMESTAMPDIFF(SECOND, rr.requested_at, NOW())) / 3600, 1)
                                                            AS hours_waiting,
           fn_level_weight(ri.urgency)                      AS u_part,
           COALESCE(fn_level_weight(lo.severity), 0.50)     AS s_part,
           ROUND(COALESCE(lo.affected_percentage, 0) / 100, 4) AS a_part,
           fn_wait_pressure(rr.requested_at, NOW())         AS w_part,
           fn_deadline_pressure(rr.required_by, NOW())      AS d_part
      FROM request_item ri
      JOIN resource_request rr ON rr.request_id   = ri.request_id
      JOIN emergency_impact ei ON ei.impact_id    = rr.impact_id
      JOIN emergency e         ON e.emergency_id  = ei.emergency_id
      JOIN location l          ON l.location_id   = ei.location_id
      JOIN resource r          ON r.resource_id   = ri.resource_id
      LEFT JOIN alloc al       ON al.request_item_id = ri.request_item_id
      LEFT JOIN latest_obs lo  ON lo.impact_id = ei.impact_id AND lo.rn = 1
     WHERE ri.status IN ('PENDING', 'PARTIAL')
       AND rr.status <> 'CANCELLED'
       AND e.status <> 'CLOSED'
)
SELECT base.*,
       fn_priority_from_parts(u_part, s_part, a_part, w_part, d_part) AS priority_score
  FROM base;

-- ---------------------------------------------------------------------------
-- v_stock_availability: one row per resource × center pair that has any batch.
--
-- usable_quantity and usable_batches count usable batches only, and are 0 (not
-- NULL) for a pair whose batches are all empty or expired. earliest_usable_expiry
-- is NULL when no usable batch has an expiry date. Centers of every status are
-- included (with center_status); consumers filter.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE
    SQL SECURITY INVOKER
    VIEW v_stock_availability AS
SELECT s.resource_id,
       r.name                AS resource_name,
       r.category,
       r.unit,
       s.center_id,
       c.name                AS center_name,
       c.center_type,
       c.status              AS center_status,
       l.latitude,
       l.longitude,
       SUM(IF(s.usable, s.quantity_available, 0)) AS usable_quantity,
       COUNT(IF(s.usable, 1, NULL))               AS usable_batches,
       MIN(IF(s.usable, s.expiry_date, NULL))     AS earliest_usable_expiry
  FROM (
        SELECT st.*,
               (st.quantity_available > 0
                AND (st.expiry_date IS NULL OR st.expiry_date >= CURDATE())) AS usable
          FROM stock st
       ) s
  JOIN resource r        ON r.resource_id = s.resource_id
  JOIN resource_center c ON c.center_id   = s.center_id
  JOIN location l        ON l.location_id = c.location_id
 GROUP BY s.resource_id, r.name, r.category, r.unit,
          s.center_id, c.name, c.center_type, c.status, l.latitude, l.longitude;

-- ---------------------------------------------------------------------------
-- v_expiring_stock: batches with stock left that expire from today to
-- today + 7 days inclusive. days_left is 0 for a batch expiring today.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE
    SQL SECURITY INVOKER
    VIEW v_expiring_stock AS
SELECT s.stock_id,
       s.batch_code,
       s.resource_id,
       r.name                              AS resource_name,
       r.unit,
       s.center_id,
       c.name                              AS center_name,
       s.quantity_available,
       s.expiry_date,
       DATEDIFF(s.expiry_date, CURDATE())  AS days_left
  FROM stock s
  JOIN resource r        ON r.resource_id = s.resource_id
  JOIN resource_center c ON c.center_id   = s.center_id
 WHERE s.quantity_available > 0
   AND s.expiry_date BETWEEN CURDATE() AND CURDATE() + INTERVAL 7 DAY;
