/**
 * Reading columns out of a plan's condition strings.
 *
 * PostgreSQL prints conditions as SQL-ish text: `(user_id = 42)`,
 * `((status)::text = 'active'::text)`, `((a = 1) AND (b > 2))`. To suggest an
 * index we need the columns and, crucially, *how* each is compared — equality
 * and range predicates belong in different positions in a composite index.
 */

export type Comparison = "equality" | "range" | "other";

export interface ConditionColumn {
  column: string;
  comparison: Comparison;
}

/** Strips `::type` casts, which appear all over EXPLAIN output. */
function stripCasts(text: string): string {
  return text.replace(/::[a-zA-Z_][a-zA-Z0-9_ ]*(\[\])?/g, "");
}

/** Removes quoted literals so their contents are never read as columns. */
function stripLiterals(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "'?'");
}

const EQUALITY = new Set(["=", "IS", "IN", "ANY", "="]);
const RANGE = new Set([">", "<", ">=", "<=", "BETWEEN"]);

function classify(operator: string): Comparison {
  const op = operator.trim().toUpperCase();
  if (EQUALITY.has(op)) return "equality";
  if (RANGE.has(op)) return "range";
  return "other";
}

/**
 * Extracts the columns compared in a condition string, with the kind of
 * comparison used. Order of appearance is preserved; duplicates collapse,
 * keeping the strongest comparison seen (equality beats range).
 *
 * This is deliberately a pattern match rather than a SQL parser: the input is
 * PostgreSQL's own rendering, not arbitrary SQL, and a wrong guess costs a
 * suboptimal suggestion, not a crash.
 */
export function columnsInCondition(condition: string): ConditionColumn[] {
  const text = stripCasts(stripLiterals(condition));
  const found = new Map<string, Comparison>();

  // `alias.column <op> …` or `column <op> …`.
  //
  // The `\)?` matters: EXPLAIN wraps a cast column in parentheses, so
  // `((status)::text = 'active')` becomes `((status) = '?')` once the cast is
  // stripped, leaving a bracket between the column and the operator.
  const comparison =
    /(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\)?\s*(>=|<=|<>|!=|=|>|<|~~\*?|IS(?:\s+NOT)?|IN)\s/gi;

  for (const match of text.matchAll(comparison)) {
    const column = match[2];
    const operator = match[3];
    if (column === undefined || operator === undefined) continue;
    if (isKeyword(column)) continue;

    const kind = classify(operator.startsWith("IS") ? "IS" : operator);
    const existing = found.get(column);
    if (existing === undefined || (existing !== "equality" && kind === "equality")) {
      found.set(column, kind);
    }
  }

  return [...found].map(([column, comparison]) => ({ column, comparison }));
}

const KEYWORDS = new Set([
  "and", "or", "not", "null", "true", "false", "any", "all", "case", "when",
  "then", "else", "end", "in", "is", "like", "ilike",
]);

function isKeyword(word: string): boolean {
  return KEYWORDS.has(word.toLowerCase());
}

/**
 * Orders columns the way a composite index wants them: equality predicates
 * first, then one range predicate. A range column placed before an equality
 * column makes the rest of the index unusable for the equality lookup — the
 * single most common mistake when hand-writing a composite index.
 */
export function orderForIndex(columns: readonly ConditionColumn[]): string[] {
  const equality = columns.filter((c) => c.comparison === "equality");
  const range = columns.filter((c) => c.comparison === "range");
  const other = columns.filter((c) => c.comparison === "other");

  // Only the first range column can use the index; further ones are filters.
  return [...equality, ...range.slice(0, 1), ...other].map((c) => c.column);
}
