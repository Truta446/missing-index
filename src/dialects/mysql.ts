import { rowsOf, type ScanNode } from "../plan.js";
import type { Dialect } from "./types.js";

/**
 * MySQL's `EXPLAIN FORMAT=JSON` is shaped nothing like PostgreSQL's: a
 * `query_block` containing `table` objects, nested through `nested_loop`,
 * `ordering_operation` and friends rather than a uniform `Plans` array.
 *
 * The equivalent of a sequential scan is `access_type: "ALL"`.
 */

const SELECT_ONLY =
  /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*|#[^\n]*\n\s*)*(?:with\b[\s\S]*?\bselect\b|select\b)/i;

interface MySqlTable {
  table_name?: string;
  access_type?: string;
  rows_examined_per_scan?: number;
  rows_produced_per_join?: number;
  filtered?: string | number;
  attached_condition?: string;
  cost_info?: { read_cost?: string; eval_cost?: string; prefix_cost?: string };
}

/** Walks every `table` object in a MySQL plan, whatever it is nested inside. */
function* tables(node: unknown): Generator<MySqlTable> {
  if (Array.isArray(node)) {
    for (const item of node) yield* tables(item);
    return;
  }
  if (typeof node !== "object" || node === null) return;

  const record = node as Record<string, unknown>;
  if ("table" in record) {
    const table = record["table"];
    if (typeof table === "object" && table !== null) yield table as MySqlTable;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "table") continue;
    yield* tables(value);
  }
}

export const mysql: Dialect = {
  name: "mysql",

  explainStatement(sql) {
    // No ANALYZE: MySQL 8.0.18+ has EXPLAIN ANALYZE and it executes the query.
    return `EXPLAIN FORMAT=JSON ${sql}`;
  },

  isExplainable(sql) {
    if (!SELECT_ONLY.test(sql)) return false;
    if (/\b(insert|update|delete|truncate|drop|alter|create)\b/i.test(sql)) return false;
    if (/^\s*explain\b/i.test(sql)) return false;
    return true;
  },

  parseScans(raw) {
    let value: unknown = raw;

    // The plan arrives as a single row holding a JSON string under EXPLAIN.
    const rows = rowsOf(value);
    if (rows.length > 0) {
      const first = rows[0] as Record<string, unknown>;
      value = first["EXPLAIN"] ?? first["explain"] ?? first;
    }
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return [];
      }
    }

    const scans: ScanNode[] = [];
    for (const table of tables(value)) {
      // "ALL" is MySQL's full table scan.
      if (table.access_type !== "ALL") continue;
      const name = table.table_name;
      const filter = table.attached_condition;
      if (name === undefined || filter === undefined || filter.trim() === "") continue;

      const examined = table.rows_examined_per_scan ?? 0;
      const filtered = Number(table.filtered ?? 100);
      // MySQL reports rows examined plus a percentage kept, rather than a row
      // count out. Convert so `returnedRows` means the same thing everywhere.
      const produced =
        table.rows_produced_per_join ??
        (Number.isFinite(filtered) ? Math.round((examined * filtered) / 100) : examined);

      scans.push({
        table: name,
        filter: filter.trim(),
        returnedRows: produced,
        cost: Number(table.cost_info?.read_cost ?? Number.NaN) || undefined,
      });
    }
    return scans;
  },

  tableSizeQuery(tables_) {
    const placeholders = tables_.map(() => "?").join(", ");
    return {
      sql:
        "SELECT TABLE_NAME AS name, TABLE_ROWS AS `rows` FROM information_schema.TABLES " +
        `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
      params: [...tables_],
    };
  },

  parseTableSizes(raw) {
    const sizes = new Map<string, number>();
    for (const row of rowsOf(raw)) {
      const name = row["name"];
      const count = Number(row["rows"]);
      if (typeof name === "string" && Number.isFinite(count) && count >= 0) {
        sizes.set(name, count);
      }
    }
    return sizes;
  },

  buildStatement(table, columns) {
    // 64 characters is MySQL's identifier limit.
    const name = `idx_${table}_${columns.join("_")}`.toLowerCase().slice(0, 64);
    const quoted = columns.map((c) => `\`${c}\``).join(", ");
    // MySQL has no CONCURRENTLY. INPLACE with LOCK=NONE is the equivalent
    // promise — the table stays writable while the index is built.
    return (
      `CREATE INDEX ${name} ON \`${table}\` (${quoted}) ` +
      "ALGORITHM=INPLACE, LOCK=NONE;"
    );
  },
};
