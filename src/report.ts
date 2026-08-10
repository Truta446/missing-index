import { formatCallSite } from "./callsite.js";
import type { Finding } from "./types.js";

function useColor(): boolean {
  return (
    process.env["NO_COLOR"] === undefined &&
    process.env["TERM"] !== "dumb" &&
    process.stderr.isTTY === true
  );
}

const ESC = "";

function paint(code: string, reset: string, text: string): string {
  return useColor() ? `${ESC}${code}${text}${ESC}${reset}` : text;
}

const c = {
  dim: (s: string) => paint("[2m", "[22m", s),
  bold: (s: string) => paint("[1m", "[22m", s),
  yellow: (s: string) => paint("[33m", "[39m", s),
  green: (s: string) => paint("[32m", "[39m", s),
  cyan: (s: string) => paint("[36m", "[39m", s),
};

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function formatFinding(finding: Finding): string {
  const { suggestion } = finding;
  const read = suggestion.tableRows.toLocaleString("en-US");
  const kept = suggestion.returnedRows.toLocaleString("en-US");

  const lines = [
    `${c.bold("missing-index")} ${c.yellow("sequential scan")} on ${c.bold(suggestion.table)}` +
      c.dim(` — read ~${read} rows to return ~${kept}, ${finding.durationMs.toFixed(0)}ms`),
    `  ${c.dim("query")}  ${truncate(finding.sql, 92)}`,
    `  ${c.dim("filter")} ${truncate(suggestion.filter, 92)}`,
    `  ${c.dim("at")}     ${c.cyan(formatCallSite(finding.callsite))}`,
    "",
    `  ${c.green(suggestion.statement)}`,
  ];

  return lines.join("\n");
}

export function defaultReporter(finding: Finding): void {
  process.stderr.write(`${formatFinding(finding)}\n\n`);
}
