/**
 * The dialect-neutral shape of a plan.
 *
 * Each database describes its plans differently — PostgreSQL nests `Plan`
 * objects, MySQL nests `query_block`/`table` — but the analysis only ever needs
 * the same four facts about a full table scan. Dialects flatten their own
 * format into this, and everything downstream is shared.
 */

export interface ScanNode {
  /** Table the scan read. */
  table: string;
  /** The condition rows were filtered on, as the database printed it. */
  filter: string;
  /** Rows the database expected to survive the filter. */
  returnedRows: number;
  /** The plan's own cost estimate, when it reports one. */
  cost: number | undefined;
}

/** PostgreSQL's plan tree, typed to the subset we read. */
export interface PgPlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Alias?: string;
  "Plan Rows"?: number;
  "Total Cost"?: number;
  Filter?: string;
  "Index Cond"?: string;
  "Sort Key"?: string[];
  Plans?: PgPlanNode[];
}

/** Depth-first walk over a PostgreSQL plan tree. */
export function* walk(node: PgPlanNode): Generator<PgPlanNode> {
  yield node;
  for (const child of node.Plans ?? []) yield* walk(child);
}

/**
 * Reads the plan out of whatever shape the driver returned.
 *
 * Drivers disagree about how deeply the result is wrapped and whether the JSON
 * arrived parsed, hence the defensive unwrapping.
 */
export function extractPlan(raw: unknown): PgPlanNode | undefined {
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
    if ("Plan" in record) return record["Plan"] as PgPlanNode;
    for (const key of ["QUERY PLAN", "query plan", "queryPlan"]) {
      if (key in record) return extractPlan(record[key]);
    }
    if ("Node Type" in record) return record as unknown as PgPlanNode;
  }

  return undefined;
}

/** Normalizes the many shapes a driver may use for a result set. */
export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    // mysql2 returns [rows, fields]; take the rows if that is what this is.
    if (result.length > 0 && Array.isArray(result[0])) {
      return result[0] as Record<string, unknown>[];
    }
    return result as Record<string, unknown>[];
  }
  if (typeof result === "object" && result !== null) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}
