-- t_p1_2_functions.sql — P1.2 functions (03_functions.sql). Run with: npm run db:test
--
-- Runs as the app user (MYSQL_USER), so it also proves the app's EXECUTE on the
-- functions. Every call uses a fixed clock or literal values: it reads no table
-- and writes nothing, so it needs no fixture and no row-count check.
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

SELECT 't_p1_2_functions' AS file, JSON_LENGTH(@results) AS checks, @failures AS failures,
       IF(@failures = 0, 'PASS', 'FAIL') AS result;
