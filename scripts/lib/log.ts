// Output for the root scripts. Same rule as the CLI: one data shape, two renderers, `--json` on
// every script — so the repo's own automation is as machine-readable as the framework it builds.

export interface Finding {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly at?: string;
}

export interface ScriptResult {
  readonly ok: boolean;
  readonly script: string;
  readonly summary: string;
  readonly findings?: readonly Finding[];
  readonly data?: unknown;
  readonly lines?: readonly string[];
}

/** The 3-line contract format, identical to the one @ultimat3/cli prints. */
export function renderFinding(finding: Finding, indent = '  '): string {
  const head = finding.at === undefined ? finding.code : `${finding.code} (${finding.at})`;
  return [
    `${indent}${head}`,
    `${indent}  cause: ${finding.cause}`,
    `${indent}  fix:   ${finding.fix}`,
  ].join('\n');
}

export function render(result: ScriptResult, json: boolean): string {
  if (json) {
    return JSON.stringify({
      ok: result.ok,
      script: result.script,
      summary: result.summary,
      findings: result.findings ?? [],
      ...(result.data === undefined ? {} : { data: result.data }),
    });
  }
  const lines = [...(result.lines ?? [])];
  for (const finding of result.findings ?? []) lines.push(renderFinding(finding));
  lines.push(`${result.ok ? '✓' : '✗'} ${result.summary}`);
  return lines.join('\n');
}

/** Print and exit. Scripts call this exactly once, at the end. */
export function report(result: ScriptResult, json: boolean): never {
  process.stdout.write(`${render(result, json)}\n`);
  process.exit(result.ok ? 0 : 1);
}
