/**
 * Splits a plain SQL file (no DELIMITER) into statements. A character scanner,
 * because a naive split on ";" breaks on a comment ending in ";" or a ";" inside
 * a string. Comments are dropped; a `-- <tag>: <label>` comment is kept as the
 * label of the next statement that returns rows (the caller decides which do).
 */

export type TaggedLine = { tag: string; label: string };
export type SqlStatement = { sql: string; tags: TaggedLine[] };

const TAG_LINE = /^--\s*(Q\d+[a-z]?):\s*(.*?)\s*$/;

/** MySQL only starts a "--" comment when whitespace or the end of the line follows. */
function startsLineComment(text: string, i: number): boolean {
  if (text[i] !== "-" || text[i + 1] !== "-") return false;
  const next = text[i + 2];
  return next === undefined || /\s/.test(next);
}

export function splitStatements(text: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let current = "";
  let tags: TaggedLine[] = [];

  const finish = () => {
    if (current.trim()) statements.push({ sql: current.trim(), tags });
    current = "";
    tags = [];
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (startsLineComment(text, i)) {
      const lineEnd = text.indexOf("\n", i);
      const end = lineEnd === -1 ? text.length : lineEnd;
      const tagged = TAG_LINE.exec(text.slice(i, end));
      if (tagged) tags.push({ tag: tagged[1], label: tagged[2] });
      i = end;
    } else if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      // Copy the quoted part whole. A doubled quote closes and reopens, which
      // comes out right; a backslash escapes the next character except in backticks.
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        j += ch !== "`" && text[j] === "\\" ? 2 : 1;
      }
      current += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ";") {
      finish();
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }
  finish();
  return statements;
}
