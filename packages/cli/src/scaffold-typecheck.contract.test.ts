// The scaffold drift gate: `x new` plus every `x g` generator, written to a sandbox and compiled
// by the real `tsc` against the real workspace packages. A template is a string, and a string
// that parses has said nothing about whether it compiles — this is where that gets decided.

import { describe, expect, test } from 'bun:test';
import {
  formatDiagnostics,
  staleGapsIn,
  typecheckScaffold,
  unexpectedIn,
} from './scaffold-typecheck';

/** One compile for the file: tsc over the fixture is the cost, not the assertions. */
const report = await typecheckScaffold();

describe('contract · generated code compiles', () => {
  test('the scaffolded app has no diagnostic outside KNOWN_GAPS', () => {
    // The formatted form first: it names file, line, code and message, so a red gate is a bug
    // report rather than a count.
    expect(formatDiagnostics(unexpectedIn(report.diagnostics))).toBe('');
  });

  test('every pinned gap still reproduces', () => {
    expect(staleGapsIn(report.diagnostics).map((gap) => gap.owner)).toEqual([]);
  });

  test('the sandbox is removed once the gate has run', () => {
    expect(report.fileCount).toBeGreaterThan(100);
    expect(Bun.file(`${report.dir}/app.config.ts`).size).toBe(0);
  });
});
