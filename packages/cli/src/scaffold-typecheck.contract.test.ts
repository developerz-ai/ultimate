// The scaffold drift gate: every documented `x new`, plus every `x g` generator, written to a
// sandbox and compiled by the real `tsc` against the real workspace packages. A template is a
// string, and a string that parses has said nothing about whether it compiles — this is where
// that gets decided.

import { describe, expect, test } from 'bun:test';
import { scaffoldVariants } from './scaffold-fixture';
import {
  formatDiagnostics,
  gapsFor,
  staleGapsIn,
  typecheckScaffold,
  unexpectedIn,
} from './scaffold-typecheck';

/** One compile per variant, for the whole file: `tsc` is the cost, not the assertions. */
const reports = await Promise.all(
  scaffoldVariants().map(async (variant) => ({
    variant,
    report: await typecheckScaffold({ files: variant.files }),
    gaps: gapsFor(variant.name),
  })),
);

/** `<variant>: <diagnostic>` per line, so a red gate names the invocation as well as the file. */
const labelled = (pick: (entry: (typeof reports)[number]) => readonly string[]): string =>
  reports
    .flatMap((entry) => pick(entry).map((line) => `${entry.variant.name}: ${line}`))
    .join('\n');

describe('contract · generated code compiles', () => {
  test('no scaffold has a diagnostic outside KNOWN_GAPS', () => {
    // The formatted form first: it names variant, file, line, code and message, so a red gate is
    // a bug report rather than a count.
    expect(
      labelled(({ report, gaps }) => {
        const surplus = unexpectedIn(report.diagnostics, gaps);
        return surplus.length === 0 ? [] : formatDiagnostics(surplus).split('\n');
      }),
    ).toBe('');
  });

  test('every pinned gap still reproduces, in the variant that pinned it', () => {
    expect(
      labelled(({ report, gaps }) => staleGapsIn(report.diagnostics, gaps).map((gap) => gap.owner)),
    ).toBe('');
  });

  test('every documented scaffold is compiled, not just the one with an app in it', () => {
    // `--no-example` shipped a `packages/db/src/schema.ts` importing the slice it does not write.
    // Compiling only the example app is exactly why nothing caught it.
    expect(reports.map(({ variant }) => variant.name)).toEqual(['x new', 'x new --no-example']);
    for (const { report } of reports) expect(report.fileCount).toBeGreaterThan(50);
  });

  test('the sandbox is removed once the gate has run', () => {
    for (const { report } of reports) expect(Bun.file(`${report.dir}/app.config.ts`).size).toBe(0);
  });
});
