import { extractPlan, rowsOf, walk, type ScanNode } from "../plan.js";
import type { Dialect } from "./types.js";

/**
 * `ANALYZE` is deliberately absent: with it, PostgreSQL executes the statement
 * to measure it. The estimated plan is enough to see a sequential scan.
 */
const SELECT_ONLY =
  /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(?:with\b[\s\S]*?\bselect\b|select\b)/i;

export const postgres: Dialect = {
  name: "postgres",

  explainStatement(sql) {
    return `EXPLAIN (FORMAT JSON) ${sql}`;
  },

  isExplainable(sql) {
    if (!SELECT_ONLY.test(sql)) return false;
    // A CTE can hide a write: `WITH x AS (DELETE …) SELECT …`.
    if (/\b(insert|update|delete|truncate|drop|alter|create)\b/i.test(sql)) return false;
    if (/^\s*explain\b/i.test(sql)) return false;
    return true;
  },

  parseScans(raw) {
    const plan = extractPlan(raw);
    if (plan === undefined) return [];

    const scans: ScanNode[] = [];
    for (const node of walk(plan)) {
      if (node["Node Type"] !== "Seq Scan") continue;
      const table = node["Relation Name"];
      const filter = node.Filter;
      // A scan with no filter reads the table on purpose — no index helps.
      if (table === undefined || filter === undefined || filter.trim() === "") continue;

      scans.push({
        table,
        filter: filter.trim(),
        returnedRows: node["Plan Rows"] ?? 0,
        cost: node["Total Cost"],
      });
    }
    return scans;
  },

  tableSizeQuery(tables) {
    return {
      sql: "SELECT relname AS name, reltuples::bigint AS rows FROM pg_class WHERE relname = ANY($1)",
      params: [tables],
    };
  },

  parseTableSizes(raw) {
    const sizes = new Map<string, number>();
    for (const row of rowsOf(raw)) {
      const name = row["name"];
      const count = Number(row["rows"]);
      // reltuples is -1 on a table that has never been analysed.
      if (typeof name === "string" && Number.isFinite(count) && count >= 0) {
        sizes.set(name, count);
      }
    }
    return sizes;
  },

  buildStatement(table, columns) {
    const name = `idx_${table}_${columns.join("_")}`.toLowerCase().slice(0, 63);
    const quoted = columns.map((c) => `"${c}"`).join(", ");
    // CONCURRENTLY so the suggestion is safe on a live table: a plain
    // CREATE INDEX holds a lock that blocks writes for its whole duration.
    return `CREATE INDEX CONCURRENTLY ${name} ON "${table}" (${quoted});`;
  },
};
