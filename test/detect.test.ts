import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, inspect } from "../src/index.js";
import type { Finding } from "../src/types.js";

const PLAN = [
  {
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      "Plan Rows": 80_000,
      "Total Cost": 4321,
      Filter: "(user_id = 42)",
    },
  },
];

/**
 * Stands in for the driver. Answers two different questions: the EXPLAIN
 * itself, and the follow-up asking how big the scanned tables are.
 */
function explainer(plan: unknown = PLAN, tableRows = 80_000) {
  const calls: string[] = [];
  const explain = async (sql: string) => {
    calls.push(sql);
    if (sql.includes("pg_class")) {
      return { rows: [{ relname: "orders", rows: tableRows }] };
    }
    return plan;
  };
  /** Only the EXPLAIN calls, which is what the assertions care about. */
  const explains = () => calls.filter((c) => c.startsWith("EXPLAIN"));
  return { explain, calls, explains };
}

beforeEach(() => {
  resetConfig();
  configure({ enabled: true, reporter: () => {} });
});

test("suggests an index for a slow query over a large table", async () => {
  const findings: Finding[] = [];
  configure({ thresholdMs: 50, onFinding: (f) => findings.push(f) });
  const { explain, explains } = explainer();

  await inspect({
    sql: "SELECT * FROM orders WHERE user_id = $1",
    params: [42],
    durationMs: 120,
    explain,
  });

  assert.equal(findings.length, 1);
  assert.match(findings[0]!.suggestion.statement, /CREATE INDEX CONCURRENTLY .* ON "orders" \("user_id"\)/);
  assert.equal(findings[0]!.suggestion.tableRows, 80_000);
  assert.deepEqual(explains(), ["EXPLAIN (FORMAT JSON) SELECT * FROM orders WHERE user_id = $1"]);
});

test("leaves fast queries alone", async () => {
  const findings: Finding[] = [];
  configure({ thresholdMs: 50, onFinding: (f) => findings.push(f) });
  const { explain, calls } = explainer();

  await inspect({ sql: "SELECT * FROM orders WHERE user_id = $1", durationMs: 5, explain });

  assert.deepEqual(findings, []);
  assert.equal(calls.length, 0, "a fast query must not cost an extra round trip");
});

test("never explains a write", async () => {
  const { explain, calls } = explainer();
  await inspect({ sql: "UPDATE orders SET total = 1", durationMs: 500, explain });
  assert.equal(calls.length, 0);
});

test("reports each index once, however often the query runs", async () => {
  const findings: Finding[] = [];
  configure({ thresholdMs: 10, onFinding: (f) => findings.push(f) });
  const { explain } = explainer();

  for (let i = 0; i < 5; i++) {
    await inspect({ sql: "SELECT * FROM orders WHERE user_id = $1", durationMs: 99, explain });
  }

  assert.equal(findings.length, 1, "the same CREATE INDEX must not repeat");
});

test("survives an EXPLAIN that fails", async () => {
  const findings: Finding[] = [];
  configure({ thresholdMs: 10, onFinding: (f) => findings.push(f) });

  const result = await inspect({
    sql: "SELECT * FROM orders WHERE user_id = $1",
    durationMs: 99,
    explain: async () => {
      throw new Error("permission denied");
    },
  });

  assert.deepEqual(result, []);
  assert.deepEqual(findings, []);
});

test("survives a plan it cannot parse", async () => {
  configure({ thresholdMs: 10 });
  const { explain } = explainer("garbage");
  const result = await inspect({ sql: "SELECT 1 FROM orders", durationMs: 99, explain });
  assert.deepEqual(result, []);
});

test("honours the query ignore list", async () => {
  configure({ thresholdMs: 10, ignore: [/pg_catalog/] });
  const { explain, calls } = explainer();
  await inspect({ sql: "SELECT * FROM pg_catalog.pg_type", durationMs: 99, explain });
  assert.equal(calls.length, 0);
});

test("does nothing when disabled", async () => {
  configure({ enabled: false, thresholdMs: 1 });
  const { explain, calls } = explainer();
  await inspect({ sql: "SELECT * FROM orders WHERE user_id = 1", durationMs: 999, explain });
  assert.equal(calls.length, 0);
});

test("passes the call site through to the finding", async () => {
  const findings: Finding[] = [];
  configure({ thresholdMs: 10, onFinding: (f) => findings.push(f) });
  const { explain } = explainer();

  await inspect({
    sql: "SELECT * FROM orders WHERE user_id = $1",
    durationMs: 99,
    callsite: { file: "/app/orders.ts", line: 12, column: 3, function: "load" },
    explain,
  });

  assert.equal(findings[0]?.callsite?.line, 12);
});
