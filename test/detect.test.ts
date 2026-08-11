import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { configure, resetConfig, inspect, postgres } from "../src/index.js";
import { expectNoMissingIndex, captureMissingIndexes, MissingIndexError } from "../src/test.js";
import type { Finding } from "../src/types.js";

const PLAN = [
  {
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      "Plan Rows": 12,
      "Total Cost": 4321,
      Filter: "(user_id = 42)",
    },
  },
];

/**
 * Stands in for the driver. Answers two different questions: the EXPLAIN
 * itself, and the follow-up asking how big the scanned tables are.
 */
function runner(plan: unknown = PLAN, tableRows = 80_000) {
  const calls: string[] = [];
  const run = async (sql: string) => {
    calls.push(sql);
    if (sql.includes("pg_class")) {
      return { rows: [{ name: "orders", rows: tableRows }] };
    }
    return plan;
  };
  const explains = () => calls.filter((c) => c.startsWith("EXPLAIN"));
  return { run, calls, explains };
}

beforeEach(() => {
  resetConfig();
  configure({ enabled: true, reporter: () => {} });
});

test("suggests an index for a slow query over a large table", async () => {
  const findings: Finding[] = [];
  configure({ thresholdMs: 50, onFinding: (f) => findings.push(f) });
  const { run, explains } = runner();

  await inspect({
    sql: "SELECT * FROM orders WHERE user_id = $1",
    params: [42],
    durationMs: 120,
    dialect: postgres,
    run,
  });

  assert.equal(findings.length, 1);
  assert.match(findings[0]!.suggestion.statement, /CREATE INDEX CONCURRENTLY .* ON "orders"/);
  assert.equal(findings[0]!.suggestion.tableRows, 80_000);
  assert.equal(findings[0]!.dialect, "postgres");
  assert.deepEqual(explains(), ["EXPLAIN (FORMAT JSON) SELECT * FROM orders WHERE user_id = $1"]);
});

test("leaves fast queries alone", async () => {
  const { run, calls } = runner();
  configure({ thresholdMs: 50 });
  await inspect({ sql: "SELECT * FROM orders WHERE user_id = $1", durationMs: 5, dialect: postgres, run });
  assert.equal(calls.length, 0, "a fast query must not cost an extra round trip");
});

test("never explains a write", async () => {
  const { run, calls } = runner();
  configure({ thresholdMs: 10 });
  await inspect({ sql: "UPDATE orders SET total = 1", durationMs: 500, dialect: postgres, run });
  assert.equal(calls.length, 0);
});

test("reports each index once, however often the query runs", async () => {
  const findings: Finding[] = [];
  configure({ thresholdMs: 10, onFinding: (f) => findings.push(f) });
  const { run } = runner();

  for (let i = 0; i < 5; i++) {
    await inspect({ sql: "SELECT * FROM orders WHERE user_id = $1", durationMs: 99, dialect: postgres, run });
  }

  assert.equal(findings.length, 1, "the same CREATE INDEX must not repeat");
});

test("survives an EXPLAIN that fails", async () => {
  configure({ thresholdMs: 10 });
  const result = await inspect({
    sql: "SELECT * FROM orders WHERE user_id = $1",
    durationMs: 99,
    dialect: postgres,
    run: async () => {
      throw new Error("permission denied");
    },
  });
  assert.deepEqual(result, []);
});

test("survives a plan it cannot parse", async () => {
  configure({ thresholdMs: 10 });
  const { run } = runner("garbage");
  assert.deepEqual(
    await inspect({ sql: "SELECT 1 FROM orders", durationMs: 99, dialect: postgres, run }),
    [],
  );
});

test("honours the query ignore list", async () => {
  configure({ thresholdMs: 10, ignore: [/pg_catalog/] });
  const { run, calls } = runner();
  await inspect({ sql: "SELECT * FROM pg_catalog.pg_type", durationMs: 99, dialect: postgres, run });
  assert.equal(calls.length, 0);
});

test("does nothing when disabled", async () => {
  configure({ enabled: false, thresholdMs: 1 });
  const { run, calls } = runner();
  await inspect({ sql: "SELECT * FROM orders WHERE user_id = 1", durationMs: 999, dialect: postgres, run });
  assert.equal(calls.length, 0);
});

// --- the CI helper ----------------------------------------------------------

test("expectNoMissingIndex passes when every query uses an index", async () => {
  const { run } = runner([{ Plan: { "Node Type": "Index Scan", "Relation Name": "orders" } }]);

  await expectNoMissingIndex(async () => {
    await inspect({ sql: "SELECT * FROM orders WHERE id = $1", durationMs: 1, dialect: postgres, run });
  });
});

test("expectNoMissingIndex fails with the CREATE INDEX in the message", async () => {
  const { run } = runner();

  await assert.rejects(
    () =>
      expectNoMissingIndex(
        async () => {
          await inspect({ sql: "SELECT * FROM orders WHERE user_id = $1", durationMs: 1, dialect: postgres, run });
        },
        { name: "orders page" },
      ),
    (error: unknown) => {
      assert.ok(error instanceof MissingIndexError);
      assert.match(error.message, /Expected no missing indexes in orders page/);
      assert.match(error.message, /CREATE INDEX CONCURRENTLY/);
      return true;
    },
  );
});

test("the helper waits for inspections that outlive the callback", async () => {
  // The adapter fires the EXPLAIN without awaiting it, so a finding may not
  // exist yet when the callback returns. A fixed sleep would be slow and
  // flaky; the helper counts inspections instead.
  const { run } = runner();

  const { findings } = await captureMissingIndexes(
    () => {
      // Deliberately not awaited — this is what an adapter does.
      void inspect({
        sql: "SELECT * FROM orders WHERE user_id = $1",
        durationMs: 1,
        dialect: postgres,
        run,
      });
    },
    // captureMissingIndexes keeps the configured threshold; only the assertion
    // helper forces it to zero.
    { thresholdMs: 0 },
  );

  assert.equal(findings.length, 1, "the pending inspection must be awaited");
});

test("the helper restores the previous configuration", async () => {
  configure({ thresholdMs: 999, minRows: 5 });
  const before = { ...(await import("../src/config.js")).getOptions() };

  await captureMissingIndexes(() => {});

  const after = (await import("../src/config.js")).getOptions();
  assert.equal(after.thresholdMs, before.thresholdMs);
  assert.equal(after.minRows, before.minRows);
});
