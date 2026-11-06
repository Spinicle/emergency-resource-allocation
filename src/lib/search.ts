// Turns what a user typed into a safe MySQL BOOLEAN MODE search string.
//
// Why this exists: the `?` placeholder already stops SQL injection, but boolean
// mode has its own small query language inside the string. Text such as `--`,
// `+` or `(((` is a *syntax error* in that language (MySQL error 1064), and
// test T17 requires `' OR 1=1 --` to be "treated as text: no error, no extra
// rows". So we keep only the words and write the operators ourselves.
//
//   "flood relief!"  ->  "+flood* +relief*"   every word required, prefix match
//   "' OR 1=1 --"    ->  null                 no searchable words: no rows
//
// No imports: this file is shared by server code and scripts.

/** InnoDB's default stopword list. These words aren't indexed, so requiring one would hide real matches. */
const STOPWORDS = new Set([
  "about", "are", "com", "for", "from", "how", "that", "the", "this",
  "was", "what", "when", "where", "who", "will", "with", "und", "www",
]);

/** innodb_ft_min_token_size's default: shorter words aren't indexed either. */
const MIN_WORD_LENGTH = 3;

/**
 * The boolean-mode string for MATCH ... AGAINST (? IN BOOLEAN MODE), or null if
 * the input holds no searchable word. On null, return an empty list without
 * querying: nothing can match.
 */
export function toBooleanQuery(input: string): string | null {
  // \p{L}, \p{M} and \p{N} are letters, their combining marks (needed for scripts
  // like Devanagari) and digits, in any script. `_` stays too, because InnoDB's
  // full-text parser keeps it inside a word. Everything else, including every
  // boolean-mode operator, acts as a separator and is dropped.
  const words = input.toLowerCase().match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
  const terms = [...new Set(words)].filter((w) => w.length >= MIN_WORD_LENGTH && !STOPWORDS.has(w));
  return terms.length > 0 ? terms.map((w) => `+${w}*`).join(" ") : null;
}
