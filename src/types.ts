import type { Suggestion } from "./analyze.js";

export type { Suggestion } from "./analyze.js";
export type { PlanNode } from "./plan.js";

export interface CallSite {
  file: string;
  line: number;
  column: number;
  function: string | undefined;
}

export interface Finding {
  sql: string;
  /** How long the query took, in milliseconds. */
  durationMs: number;
  suggestion: Suggestion;
  callsite: CallSite | undefined;
}

export interface Options {
  /**
   * Only explain queries slower than this, in milliseconds. Explaining every
   * query would double the round trips for no benefit — a fast query is not a
   * missing index, whatever its plan says.
   */
  thresholdMs?: number;
  /** Ignore sequential scans expected to read fewer rows than this. */
  minRows?: number;
  /** Tables to never suggest indexes for. */
  ignoreTables?: readonly RegExp[];
  /** Queries matching any of these are never explained. */
  ignore?: readonly RegExp[];
  /** Attribute each finding to a line of code. */
  captureStack?: boolean;
  /** Called once per distinct suggestion. */
  onFinding?: (finding: Finding) => void;
  /** Replaces the built-in stderr report. */
  reporter?: (finding: Finding) => void;
  /**
   * Master switch. Defaults to `process.env.NODE_ENV !== "production"`.
   * Explaining queries costs an extra round trip; that belongs in development.
   */
  enabled?: boolean;
}

export interface ResolvedOptions {
  thresholdMs: number;
  minRows: number;
  ignoreTables: readonly RegExp[];
  ignore: readonly RegExp[];
  captureStack: boolean;
  onFinding: ((finding: Finding) => void) | undefined;
  reporter: ((finding: Finding) => void) | undefined;
  enabled: boolean;
}
