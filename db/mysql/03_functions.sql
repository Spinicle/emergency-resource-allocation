-- 03_functions.sql
-- Distance and the explainable priority score (docs/HANDOFF.md 4.4, Appendix C).
--
--   score = 40·U + 30·S + 15·A + 10·W + 5·D   (0–100, 2 dp)
--
-- Binary logging is on and log_bin_trust_function_creators is off, so every
-- function declares its characteristics. The clock is passed in as p_now, which
-- keeps the pressure helpers pure (DETERMINISTIC NO SQL). Only fn_priority_score
-- reads tables and the clock itself.
--
-- v_priority_queue (04_views.sql) computes the five parts with these same helpers
-- and combines them with fn_priority_from_parts, so the view and fn_priority_score
-- can't drift apart.
--
-- All functions run with the caller's privileges (SQL SECURITY INVOKER).

DELIMITER $$

-- ---------------------------------------------------------------------------
-- fn_distance_km: great-circle distance between two points, haversine, R = 6371.
-- Used by sp_suggest_batches (nearest center first) and important query 4.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_distance_km $$
CREATE FUNCTION fn_distance_km(
    p_lat1 DECIMAL(10,7),
    p_lng1 DECIMAL(10,7),
    p_lat2 DECIMAL(10,7),
    p_lng2 DECIMAL(10,7)
)
RETURNS DECIMAL(10,3)
DETERMINISTIC
NO SQL
SQL SECURITY INVOKER
COMMENT 'Haversine distance in km between two lat/lng points'
BEGIN
    DECLARE v_a DOUBLE;
    SET v_a = POW(SIN(RADIANS(p_lat2 - p_lat1) / 2), 2)
            + COS(RADIANS(p_lat1)) * COS(RADIANS(p_lat2))
              * POW(SIN(RADIANS(p_lng2 - p_lng1) / 2), 2);
    -- LEAST stops rounding from pushing the ASIN argument past 1 (which gives NULL).
    RETURN ROUND(2 * 6371 * ASIN(LEAST(1, SQRT(v_a))), 3);
END $$

-- ---------------------------------------------------------------------------
-- fn_level_weight: weight of an urgency or severity level (parts U and S).
-- NULL in gives NULL out, so a caller that forgets COALESCE(…, 0.50) for "no
-- observation" produces a NULL score instead of a quietly wrong one.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_level_weight $$
CREATE FUNCTION fn_level_weight(p_level VARCHAR(30))
RETURNS DECIMAL(3,2)
DETERMINISTIC
NO SQL
SQL SECURITY INVOKER
COMMENT 'LOW .25, MEDIUM/MODERATE .5, HIGH .75, CRITICAL 1, NULL -> NULL, else 0'
BEGIN
    RETURN CASE
        WHEN p_level IS NULL                  THEN NULL
        WHEN p_level = 'LOW'                  THEN 0.25
        WHEN p_level IN ('MEDIUM', 'MODERATE') THEN 0.50
        WHEN p_level = 'HIGH'                 THEN 0.75
        WHEN p_level = 'CRITICAL'             THEN 1.00
        ELSE 0.00
    END;
END $$

-- ---------------------------------------------------------------------------
-- fn_deadline_pressure: part D. No deadline 0; overdue or due within 6 h 1;
-- within 24 h 0.6; later 0.2. Boundaries are inclusive, to the second.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_deadline_pressure $$
CREATE FUNCTION fn_deadline_pressure(p_required_by DATETIME, p_now DATETIME)
RETURNS DECIMAL(3,2)
DETERMINISTIC
NO SQL
SQL SECURITY INVOKER
COMMENT 'Part D: NULL 0, <= 6 h (incl. overdue) 1, <= 24 h 0.6, later 0.2'
BEGIN
    DECLARE v_secs_left BIGINT;
    IF p_now IS NULL THEN
        RETURN NULL;
    END IF;
    IF p_required_by IS NULL THEN
        RETURN 0.00;
    END IF;
    SET v_secs_left = TIMESTAMPDIFF(SECOND, p_now, p_required_by);
    RETURN CASE
        WHEN v_secs_left <= 6 * 3600  THEN 1.00
        WHEN v_secs_left <= 24 * 3600 THEN 0.60
        ELSE 0.20
    END;
END $$

-- ---------------------------------------------------------------------------
-- fn_wait_pressure: part W. Hours waiting / 48, clamped to [0, 1], 4 dp.
-- A requested_at in the future counts as 0, not negative.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_wait_pressure $$
CREATE FUNCTION fn_wait_pressure(p_requested_at DATETIME, p_now DATETIME)
RETURNS DECIMAL(5,4)
DETERMINISTIC
NO SQL
SQL SECURITY INVOKER
COMMENT 'Part W: seconds waiting / 172800 (48 h), clamped to [0, 1]'
BEGIN
    IF p_requested_at IS NULL OR p_now IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN ROUND(
        LEAST(1, GREATEST(0, TIMESTAMPDIFF(SECOND, p_requested_at, p_now)) / 172800),
        4);
END $$

-- ---------------------------------------------------------------------------
-- fn_priority_from_parts: the weighted sum. The only place the weights live.
-- Any NULL part gives a NULL score.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_priority_from_parts $$
CREATE FUNCTION fn_priority_from_parts(
    p_u DECIMAL(5,4),
    p_s DECIMAL(5,4),
    p_a DECIMAL(5,4),
    p_w DECIMAL(5,4),
    p_d DECIMAL(5,4)
)
RETURNS DECIMAL(5,2)
DETERMINISTIC
NO SQL
SQL SECURITY INVOKER
COMMENT '40U + 30S + 15A + 10W + 5D, rounded to 2 dp'
BEGIN
    RETURN ROUND(40 * p_u + 30 * p_s + 15 * p_a + 10 * p_w + 5 * p_d, 2);
END $$

-- ---------------------------------------------------------------------------
-- fn_priority_score: the 0–100 score of one request item, as of now.
--   U  the item's urgency
--   S  latest severity of the request's impact (no observation: 0.5)
--   A  latest affected % / 100 (no observation: 0)
--   W  wait since the request was made
--   D  pressure from the request's deadline
-- Returns NULL if the item doesn't exist. Parameters and locals are prefixed
-- p_ / v_ so none of them hides a column inside a query.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_priority_score $$
CREATE FUNCTION fn_priority_score(p_item_id INT)
RETURNS DECIMAL(5,2)
NOT DETERMINISTIC
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'Priority score 0-100 of a request item (HANDOFF Appendix C)'
BEGIN
    -- Inside a function, NOW() is the time this call started.
    DECLARE v_now DATETIME DEFAULT NOW();
    DECLARE v_urgency VARCHAR(30);
    DECLARE v_requested_at DATETIME;
    DECLARE v_required_by DATETIME;
    DECLARE v_impact_id INT;
    DECLARE v_severity VARCHAR(30);
    DECLARE v_affected_pct DECIMAL(5,2);

    IF NOT EXISTS (SELECT 1 FROM request_item WHERE request_item_id = p_item_id) THEN
        RETURN NULL;
    END IF;

    SELECT ri.urgency, rr.requested_at, rr.required_by, rr.impact_id
      INTO v_urgency, v_requested_at, v_required_by, v_impact_id
      FROM request_item ri
      JOIN resource_request rr ON rr.request_id = ri.request_id
     WHERE ri.request_item_id = p_item_id;

    -- Scalar subqueries: no observation gives NULL without warning 1329.
    -- uq_impact_observation_time (impact_id, observed_at) serves both.
    SET v_severity = (
        SELECT o.severity
          FROM impact_observation o
         WHERE o.impact_id = v_impact_id
         ORDER BY o.observed_at DESC
         LIMIT 1);
    SET v_affected_pct = (
        SELECT o.affected_percentage
          FROM impact_observation o
         WHERE o.impact_id = v_impact_id
         ORDER BY o.observed_at DESC
         LIMIT 1);

    RETURN fn_priority_from_parts(
        fn_level_weight(v_urgency),
        COALESCE(fn_level_weight(v_severity), 0.50),
        ROUND(COALESCE(v_affected_pct, 0) / 100, 4),
        fn_wait_pressure(v_requested_at, v_now),
        fn_deadline_pressure(v_required_by, v_now));
END $$

DELIMITER ;
