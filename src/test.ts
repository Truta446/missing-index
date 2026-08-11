/**
 * Test helpers.
 *
 * This is the part that keeps an unindexed query from coming back. A detector
 * you have to remember to read decays; an assertion in the suite does not.
 *
 * The awkward part is that suggestions arrive **asynchronously** — the EXPLAIN
 * runs after the query resolves, so a finding may not exist yet when the
 * callback returns. Rather than sleep for a guessed duration, the library
 * counts inspections in flight and these helpers await that count reaching
 * zero: fast when there is nothing pending, and never flaky.
 */

import { configure, getOptions, restoreConfig } from "./config.js";
import { settled } from "./inflight.js";
import { formatFinding } from "./report.js";
import type { Finding, Options } from "./types.js";

export interface CaptureResult {
  findings: readonly Finding[];
}

async function withOptions<T>(overrides: Options, fn: () => Promise<T>): Promise<T> {
  const previous = getOptions();
  configure(overrides);
  try {
    return await fn();
  } finally {
    restoreConfig(previous);
  }
}

/**
 * Runs `fn` and returns every missing index it revealed, without printing.
 *
 * ```ts
 * const { findings } = await captureMissingIndexes(() => loadOrdersPage(userId));
 * ```
 */
export async function captureMissingIndexes(
  fn: () => unknown | Promise<unknown>,
  options: Options = {},
): Promise<CaptureResult> {
  const findings: Finding[] = [];

  await withOptions(
    {
      ...options,
      enabled: true,
      onFinding: (finding) => {
        findings.push(finding);
        options.onFinding?.(finding);
      },
      reporter: () => {},
    },
    async () => {
      await fn();
      // Let the EXPLAINs triggered inside `fn` finish before reading results.
      await settled();
    },
  );

  return { findings };
}

export class MissingIndexError extends Error {
  override readonly name = "MissingIndexError";
  readonly findings: readonly Finding[];

  constructor(findings: readonly Finding[], label: string) {
    const body = findings.map((f) => formatFinding(f)).join("\n\n");
    super(
      `Expected no missing indexes in ${label}, found ${findings.length}:\n\n${body}\n`,
    );
    this.findings = findings;
  }
}

export interface AssertOptions extends Options {
  /** Label used in the failure message. */
  name?: string;
}

/**
 * Fails when `fn` runs a query that wants an index it does not have.
 *
 * Drop it into any test runner — it throws a plain `Error`, so Jest, Vitest and
 * `node:test` all report it correctly.
 *
 * ```ts
 * test("orders page uses its indexes", async () => {
 *   await expectNoMissingIndex(() => loadOrdersPage(userId));
 * });
 * ```
 *
 * Note the thresholds: by default only queries slower than `thresholdMs` are
 * explained, and a fast test database may never cross it. For a test, setting
 * `thresholdMs: 0` makes the assertion about the *plan* rather than about how
 * fast the machine happened to be — which is what you want in CI.
 */
export async function expectNoMissingIndex(
  fn: () => unknown | Promise<unknown>,
  options: AssertOptions = {},
): Promise<CaptureResult> {
  const { name = "this block", ...rest } = options;

  const result = await captureMissingIndexes(fn, {
    // A test asserts on the plan, not on the speed of the CI runner.
    thresholdMs: 0,
    ...rest,
  });

  if (result.findings.length > 0) {
    throw new MissingIndexError(result.findings, name);
  }
  return result;
}
