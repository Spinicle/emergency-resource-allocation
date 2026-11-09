-- 11_analytics_views.sql
-- Read models for /analytics (docs/HANDOFF.md P2.5).
--
-- Like 04_views.sql, every view runs with the caller's privileges
-- (SQL SECURITY INVOKER) and has no ORDER BY: consumers order them.
--
-- "Allocated" is every allocation that isn't CANCELLED (RESERVED, DISPATCHED,
-- DELIVERED), the same rule request_item.quantity_allocated and the item's
-- FULFILLED status follow. Cancelled items and requests aren't asking for
-- anything any more, so they count nowhere here.

-- ---------------------------------------------------------------------------
-- v_unmet_demand: one row per emergency x resource that has live requested items.
--
-- Allocations are summed per item before the join: joining the allocation table
-- directly would repeat an item once per allocation and inflate its requested
-- quantity.
--
-- quantity_unmet can't go below 0: chk_request_item_quantity_allocated and
-- trg_item_bu keep allocated <= requested on every item. It isn't clamped, so a
-- broken invariant would show up instead of being hidden.
--
-- Rows with quantity_unmet = 0 and CLOSED emergencies stay in; consumers filter.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE
    SQL SECURITY INVOKER
    VIEW v_unmet_demand AS
WITH alloc AS (
    SELECT a.request_item_id,
           SUM(a.quantity_allocated) AS qty
      FROM allocation a
     WHERE a.status <> 'CANCELLED'
     GROUP BY a.request_item_id
)
SELECT e.emergency_id,
       e.name                                                AS emergency_name,
       e.status                                              AS emergency_status,
       r.resource_id,
       r.name                                                AS resource_name,
       r.category,
       r.unit,
       COUNT(*)                                              AS item_count,
       SUM(ri.quantity_requested)                            AS quantity_requested,
       SUM(COALESCE(al.qty, 0))                              AS quantity_allocated,
       SUM(ri.quantity_requested - COALESCE(al.qty, 0))      AS quantity_unmet
  FROM request_item ri
  JOIN resource_request rr ON rr.request_id   = ri.request_id
  JOIN emergency_impact ei ON ei.impact_id    = rr.impact_id
  JOIN emergency e         ON e.emergency_id  = ei.emergency_id
  JOIN resource r          ON r.resource_id   = ri.resource_id
  LEFT JOIN alloc al       ON al.request_item_id = ri.request_item_id
 WHERE ri.status <> 'CANCELLED'
   AND rr.status <> 'CANCELLED'
 GROUP BY e.emergency_id, e.name, e.status,
          r.resource_id, r.name, r.category, r.unit;

-- ---------------------------------------------------------------------------
-- v_fulfilment_rate: one row per emergency, CLOSED ones included.
--
-- item_rate_pct      fulfilled items / live items.
-- quantity_rate_pct  each item's own allocated / requested share, averaged.
--                    A plain SUM(allocated) / SUM(requested) would add litres to
--                    kits, so bulk water would decide the number.
--
-- An emergency with no live items keeps its row, with zero counts and NULL rates
-- (NULLIF stops the division by zero).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE
    SQL SECURITY INVOKER
    VIEW v_fulfilment_rate AS
WITH alloc AS (
    SELECT a.request_item_id,
           SUM(a.quantity_allocated) AS qty
      FROM allocation a
     WHERE a.status <> 'CANCELLED'
     GROUP BY a.request_item_id
),
items AS (
    SELECT ei.emergency_id,
           ri.request_item_id,
           ri.status,
           ri.quantity_requested,
           COALESCE(al.qty, 0) AS allocated
      FROM request_item ri
      JOIN resource_request rr ON rr.request_id = ri.request_id
      JOIN emergency_impact ei ON ei.impact_id  = rr.impact_id
      LEFT JOIN alloc al       ON al.request_item_id = ri.request_item_id
     WHERE ri.status <> 'CANCELLED'
       AND rr.status <> 'CANCELLED'
)
SELECT e.emergency_id,
       e.name                                                        AS emergency_name,
       e.type                                                        AS emergency_type,
       e.status                                                      AS emergency_status,
       COUNT(i.request_item_id)                                      AS items_total,
       COUNT(CASE WHEN i.status = 'FULFILLED' THEN 1 END)            AS items_fulfilled,
       COUNT(CASE WHEN i.status = 'PARTIAL'   THEN 1 END)            AS items_partial,
       COUNT(CASE WHEN i.status = 'PENDING'   THEN 1 END)            AS items_pending,
       ROUND(100 * COUNT(CASE WHEN i.status = 'FULFILLED' THEN 1 END)
                 / NULLIF(COUNT(i.request_item_id), 0), 2)           AS item_rate_pct,
       ROUND(100 * SUM(i.allocated / i.quantity_requested)
                 / NULLIF(COUNT(i.request_item_id), 0), 2)           AS quantity_rate_pct
  FROM emergency e
  LEFT JOIN items i ON i.emergency_id = e.emergency_id
 GROUP BY e.emergency_id, e.name, e.type, e.status;

-- ---------------------------------------------------------------------------
-- v_escalating_impacts: impacts whose latest observation is worse than the one
-- before it. Important query 7 (Appendix B), without its ORDER BY because views
-- here have none. Consumers order by sev_rank DESC, observed_at DESC.
--
-- uq_impact_observation_time rules out ties in the window ordering. An impact
-- with one observation has no previous rank, so it never qualifies.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE
    SQL SECURITY INVOKER
    VIEW v_escalating_impacts AS
WITH ranked AS (
    SELECT o.impact_id,
           o.observed_at,
           o.severity,
           FIELD(o.severity, 'LOW', 'MODERATE', 'HIGH', 'CRITICAL')                        AS sev_rank,
           LAG(FIELD(o.severity, 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'))
               OVER (PARTITION BY o.impact_id ORDER BY o.observed_at)                      AS prev_rank,
           LAG(o.severity)
               OVER (PARTITION BY o.impact_id ORDER BY o.observed_at)                      AS prev_severity,
           ROW_NUMBER() OVER (PARTITION BY o.impact_id ORDER BY o.observed_at DESC)        AS rn
      FROM impact_observation o
)
SELECT e.emergency_id,
       e.name    AS emergency,
       e.status  AS emergency_status,
       ei.impact_id,
       ei.status AS impact_status,
       l.grid_id,
       r.severity,
       r.prev_severity,
       r.sev_rank,
       r.prev_rank,
       r.observed_at
  FROM ranked r
  JOIN emergency_impact ei ON ei.impact_id   = r.impact_id
  JOIN emergency e         ON e.emergency_id = ei.emergency_id
  JOIN location l          ON l.location_id  = ei.location_id
 WHERE r.rn = 1
   AND r.sev_rank > r.prev_rank;
