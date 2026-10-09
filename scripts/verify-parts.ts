#!/usr/bin/env bun
// The gate-part documents the `verify` CI job merges: each part's newest attempt, from the
// directory `download-artifact` filled. `data` is the list `x verify merge` is handed; an earlier
// attempt's copy of a part is named in the log and left out (`lib/ci-attempt-parts.ts`).
//
//   bun run scripts/verify-parts.ts <dir> [--json]

// why: host-separator paths into the download directory; Bun ships no path API.
import { join } from 'node:path';
import { parseScriptArgs } from './lib/args';
import { currentAttemptParts } from './lib/ci-attempt-parts';
import type { Finding } from './lib/log';
import { report } from './lib/log';

const SCRIPT = 'verify-parts';

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const dir = args.positionals[0];
  if (dir === undefined) {
    report(
      {
        ok: false,
        script: SCRIPT,
        summary: 'no directory to read',
        findings: [
          {
            code: 'X_CLI_BAD_FLAG',
            cause:
              'verify-parts was run without the directory the part documents were downloaded to',
            fix: 'bun run scripts/verify-parts.ts "$RUNNER_TEMP/parts" --json',
          },
        ],
      },
      args.json,
    );
  }
  const files = [...new Bun.Glob('*.json').scanSync({ cwd: dir })].map((name) => join(dir, name));
  const parts = currentAttemptParts(files);
  const findings: Finding[] = parts.unnamed.map((path) => ({
    code: 'X_VERIFY_PART_UNNAMED',
    cause: `${path} names no run attempt, so it cannot be told from another attempt's copy of its part`,
    fix: "grep -n 'attempt-' .github/workflows/ci.yml   # the gate job writes each part as <part>.attempt-<github.run_attempt>.json",
    at: path,
  }));
  if (parts.current.length === 0 && findings.length === 0) {
    findings.push({
      code: 'X_VERIFY_PART_UNNAMED',
      cause: `${dir} holds no part document at all`,
      fix: "grep -n 'verify-part-' .github/workflows/ci.yml   # the gate job's upload name and the verify job's download pattern must agree",
      at: dir,
    });
  }
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary: `${parts.current.length} part document(s) to merge, ${parts.superseded.length} superseded by a re-run`,
      findings,
      data: parts.current,
      lines: parts.superseded.map((path) => `superseded by a newer attempt: ${path}`),
    },
    args.json,
  );
}
