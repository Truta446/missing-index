/**
 * PostgreSQL query plans.
 *
 * `EXPLAIN (FORMAT JSON)` returns a tree of nodes. We only care about a few
 * fields, so this types the subset we read rather than the whole grammar —
 * PostgreSQL adds keys between versions and an exhaustive type would rot.
 */

export interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Alias?: string;
  "Plan Rows"?: number;
  "Total Cost"?: number;
  Filter?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  "Hash Cond"?: string;
  "Join Filter"?: string;
  "Sort Key"?: string[];
  Plans?: PlanNode[];
}

export interface ExplainResult {
  Plan: PlanNode;
}

/** Depth-first walk over a plan tree. */
export function* walk(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* walk(child);
}

/**
 * Reads the plan out of whatever shape the driver returned.
 *
 * `EXPLAIN (FORMAT JSON)` yields a single row holding a one-element array, but
 * drivers disagree on how deeply that is wrapped and whether the JSON was
 * already parsed — hence the defensive unwrapping.
 */
export function extractPlan(raw: unknown): PlanNode | undefined {
  let value: unknown = raw;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return extractPlan(value[0]);
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;

    if ("Plan" in record) return record["Plan"] as PlanNode;

    // Some drivers hand back the row keyed by the column name.
    for (const key of ["QUERY PLAN", "query plan", "queryPlan"]) {
      if (key in record) return extractPlan(record[key]);
    }

    if ("Node Type" in record) return record as unknown as PlanNode;
  }

  return undefined;
}
