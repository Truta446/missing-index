import { setShared, shared } from "./global-state.js";
import type { Options, ResolvedOptions } from "./types.js";

function defaults(): ResolvedOptions {
  return {
    thresholdMs: 50,
    minRows: 1_000,
    ignoreTables: [],
    ignore: [],
    captureStack: true,
    onFinding: undefined,
    reporter: undefined,
    enabled: process.env["NODE_ENV"] !== "production",
  };
}

const KEY = "options";

function currentOptions(): ResolvedOptions {
  return shared(KEY, defaults);
}

export function configure(options: Options): ResolvedOptions {
  const current = currentOptions();
  return setShared(KEY, {
    thresholdMs: options.thresholdMs ?? current.thresholdMs,
    minRows: options.minRows ?? current.minRows,
    ignoreTables: options.ignoreTables ?? current.ignoreTables,
    ignore: options.ignore ?? current.ignore,
    captureStack: options.captureStack ?? current.captureStack,
    onFinding: options.onFinding ?? current.onFinding,
    reporter: options.reporter ?? current.reporter,
    enabled: options.enabled ?? current.enabled,
  });
}

export function getOptions(): ResolvedOptions {
  return currentOptions();
}

/** Replaces the configuration wholesale, to restore a snapshot. */
export function restoreConfig(snapshot: ResolvedOptions): ResolvedOptions {
  return setShared(KEY, snapshot);
}

export function resetConfig(): ResolvedOptions {
  // Also forget what has been reported, or a suggestion suppressed in one run
  // stays suppressed for the life of the process — which makes the detector
  // look broken in a test suite, and gives no way back in a long-lived app.
  reportedKeys().clear();
  return setShared(KEY, defaults());
}

/**
 * Suggestions already reported, so a query in a loop does not print the same
 * `CREATE INDEX` fifty times. Shared per process for the same reason the
 * options are — bundlers duplicate modules.
 */
export function reportedKeys(): Set<string> {
  return shared("reported", () => new Set<string>());
}
