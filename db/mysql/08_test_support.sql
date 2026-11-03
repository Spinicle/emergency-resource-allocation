-- 08_test_support.sql
-- Helpers for db/mysql/tests/*.sql only. The app never calls these.
--
-- Tests that expect an error need a handler, and handlers exist only inside
-- stored programs, which the app user can't create. sp_test_expect runs one
-- statement and reports how it ended instead of failing the test file.

DELIMITER $$

-- ---------------------------------------------------------------------------
-- sp_test_expect: run p_sql (one statement, built with CONCAT). Afterwards
-- p_errno / p_message hold its error (MYSQL_ERRNO, MESSAGE_TEXT), or 0 / NULL
-- if it succeeded. A failed statement undoes only itself; the caller's
-- transaction carries on. Runs with the caller's privileges.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_test_expect $$
CREATE PROCEDURE sp_test_expect(IN p_sql TEXT, OUT p_errno INT, OUT p_message VARCHAR(512))
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'Tests only: run one statement, report its error number and message'
BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 p_errno = MYSQL_ERRNO, p_message = MESSAGE_TEXT;
        SET @sp_test_sql = NULL;
    END;

    SET p_errno = 0, p_message = NULL;
    SET @sp_test_sql = p_sql;
    PREPARE sp_test_stmt FROM @sp_test_sql;
    EXECUTE sp_test_stmt;
    DEALLOCATE PREPARE sp_test_stmt;
    SET @sp_test_sql = NULL;
END $$

DELIMITER ;
