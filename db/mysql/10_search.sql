-- 10_search.sql
-- Part 2 full-text indexes (docs/HANDOFF.md P2.1; P2.2 adds ftx_request_desc here).
-- db:reset runs this after Part 1's files because it runs every NN_*.sql in
-- number order.
--
-- A FULLTEXT index stores words rather than whole column values, which is what
-- lets MATCH ... AGAINST find a word anywhere in a long TEXT column. A plain
-- LIKE '%word%' can't use a B-tree index and would scan the whole table.
--
-- MATCH must name exactly the columns of one index, in this order:
--   MATCH(name, description)  uses ftx_emergency_text

CREATE FULLTEXT INDEX ftx_emergency_text ON emergency(name, description);
