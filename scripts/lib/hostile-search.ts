/**
 * Search text that is valid input but hostile: T17's injection attempt, and
 * strings that are syntax errors in MySQL's boolean mode. Shared by api:test:p2
 * and test:t17. None holds a word any seeded row contains, so each must return
 * no rows.
 */
export const HOSTILE_SEARCHES = ["' OR 1=1 --", "' OR_1=1 --", "--", "+", "+-", '"', "(((", "a* *b", "@3", "<>~", "%", "\\", "_", "___"];
