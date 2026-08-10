/**
 * Running EXPLAIN safely.
 *
 * Two decisions matter here.
 *
 * `ANALYZE` is off. With it, PostgreSQL *executes* the statement to measure
 * it — which for an UPDATE or DELETE means running it a second time. The
 * estimated plan is enough to spot a sequential scan, and it cannot corrupt
 * anything.
 *
 * Only SELECTs are explained. Even without ANALYZE, explaining a write is
 * pointless (we suggest indexes for reads) and needlessly close to the edge.
 */

export type Explainer = (sql: string, params: readonly unknown[] | undefined) => Promise<unknown>;

const SELECT_ONLY = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(?:with\b[\s\S]*?\bselect\b|select\b)/i;

/** True when the statement is a read we are willing to explain. */
export function isExplainable(sql: string): boolean {
  if (!SELECT_ONLY.test(sql)) return false;
  // A CTE can hide a write: `WITH x AS (DELETE …) SELECT …`.
  if (/\b(insert|update|delete|truncate|drop|alter|create)\b/i.test(sql)) return false;
  // Do not explain our own EXPLAIN.
  if (/^\s*explain\b/i.test(sql)) return false;
  return true;
}

/** Wraps a statement so PostgreSQL returns the plan as JSON. */
export function explainStatement(sql: string): string {
  return `EXPLAIN (FORMAT JSON) ${sql}`;
}
