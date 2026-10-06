// The enforcement half of `scripts/posix-relative.ts`: the gate's `unit` step runs every
// `scripts/**/*.test.ts`, so a `relative()` from `node:path` that skips `toPosix` fails
// `bun run verify` with no extra wiring.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { maskLiterals } from '../packages/core/src/source-mask';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { BACKLOG, relativeFindings, relativeSites, scanRelative } from './posix-relative';

// Reads the real tree, so it runs on the repo-scan backstop rather than Bun's 5000ms default.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const lines = (source: string): readonly number[] =>
  scanRelative('packages/x/src/a.ts', source, maskLiterals(source)).map((site) => site.line);

describe('a relative() answer that is not written POSIX', () => {
  test('a bare call off node:path is refused, with its line', () => {
    expect(
      lines("import { join, relative } from 'node:path';\nconst at = relative(root, file);"),
    ).toEqual([2]);
  });

  test('wrapped in toPosix it is the rule kept', () => {
    expect(
      lines("import { relative } from 'node:path';\nconst at = toPosix(relative(root, file));"),
    ).toEqual([]);
  });

  test('an alias and a namespace are the same call', () => {
    expect(lines("import { relative as rel } from 'node:path';\nrel(a, b);")).toEqual([2]);
    expect(lines("import * as path from 'node:path';\n\npath.relative(a, b);")).toEqual([3]);
  });

  // Sweep 11 R4: the default import was the one spelling the rule did not read.
  test('a default import is the same module, and so is one beside named imports', () => {
    expect(lines("import path from 'node:path';\nconst at = path.relative(a, b);")).toEqual([2]);
    expect(lines("import p, { join } from 'node:path';\np.relative(a, b);")).toEqual([2]);
    expect(lines("import path from 'node:path';\npath.join(a, b);")).toEqual([]);
    expect(lines("import path from 'node:path/posix';\npath.relative(a, b);")).toEqual([]);
  });

  test('node:path/posix is POSIX already, and a comment or a string is not a call', () => {
    expect(lines("import { relative } from 'node:path/posix';\nrelative(a, b);")).toEqual([]);
    expect(
      lines(
        "import { relative } from 'node:path';\n// relative(a, b)\nconst s = 'relative(a, b)';",
      ),
    ).toEqual([]);
  });

  test('a filesystem-only answer is waived on its own line or the line above', () => {
    expect(
      lines(
        "import { relative } from 'node:path';\n// native-path: handed to Bun.file only\nconst p = relative(a, b);\nconst q = relative(a, b); // native-path: same",
      ),
    ).toEqual([]);
    expect(
      lines("import { relative } from 'node:path';\n// native-path:\nrelative(a, b);"),
    ).toEqual([3]);
  });
});

describe('the pinned backlog', () => {
  const site = (path: string, line = 1) => ({ path, line });

  test('a file over its pin is a finding naming the file and the helper', () => {
    const [finding] = relativeFindings([site('packages/cli/src/new.ts', 7)]);
    expect(finding?.code).toBe('X_RELATIVE_PATH_NOT_POSIX');
    expect(finding?.at).toBe('packages/cli/src/new.ts:7');
    expect(finding?.fix).toContain('packages/cli/src/posix-path.ts');
  });

  test('a pin the file no longer needs is stale, and says the edit', () => {
    const [path] = Object.keys(BACKLOG);
    if (path === undefined) return expect.unreachable('the backlog is not empty yet');
    const others = Object.entries(BACKLOG)
      .filter(([one]) => one !== path)
      .flatMap(([one, count]) => Array.from({ length: count }, () => site(one)));
    const stale = relativeFindings(others);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.fix).toContain(`BACKLOG['${path}']`);
  });

  test('this repository holds the rule at its pins exactly', async () => {
    expect(relativeFindings(await relativeSites(repoRoot()))).toEqual([]);
  });
});
