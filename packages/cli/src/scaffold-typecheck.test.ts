// The harness itself: diagnostic parsing, the fixture's shape, and the known-gap bookkeeping.
// Whether the scaffolded app actually compiles is the contract test next to this file.

import { describe, expect, test } from 'bun:test';
import { GENERATORS } from './cmd-generate';
import { ScaffoldPathEscapeError } from './errors';
import { FIXTURE_GENERATORS, scaffoldFixture, scaffoldVariants } from './scaffold-fixture';
import {
  formatDiagnostics,
  gapsFor,
  KNOWN_GAPS,
  parseDiagnostics,
  sandboxPath,
  staleGapsIn,
  unexpectedIn,
} from './scaffold-typecheck';

const gap = { file: 'apps/web/app/post/entity.ts', line: 20, code: 'TS18048' } as const;
const pinned = { ...gap, message: "'c.title' is possibly 'undefined'." };
/** Every pin satisfied at once, so a test can assert on the surplus alone. */
const allPinned = KNOWN_GAPS.map((entry) => ({
  file: entry.file,
  line: 20,
  code: entry.code,
  message: entry.message,
}));

describe('unit · scaffold typecheck harness', () => {
  test('parses both diagnostic shapes tsc emits', () => {
    const parsed = parseDiagnostics(
      ["src/a.ts(3,7): error TS2307: Cannot find module './b'.", 'error TS5083: bad config'].join(
        '\n',
      ),
    );
    expect(parsed).toEqual([
      { file: 'src/a.ts', line: 3, code: 'TS2307', message: "Cannot find module './b'." },
      { file: '', line: 0, code: 'TS5083', message: 'bad config' },
    ]);
  });

  test('CRLF output parses to the same diagnostics, so a pinned gap still matches', () => {
    const crlf = [
      "apps/web/app/post/entity.ts(20,1): error TS18048: 'c.title' is possibly 'undefined'.",
      'error TS5083: bad config',
      '',
    ].join('\r\n');
    expect(parseDiagnostics(crlf)).toEqual([
      pinned,
      { file: '', line: 0, code: 'TS5083', message: 'bad config' },
    ]);
    // The point of the split: a trailing \r inside the message would defeat every pin.
    expect(unexpectedIn(parseDiagnostics(crlf).slice(0, 1))).toEqual([]);
  });

  test('a config error carries no file and still counts — a silent harness is a green lie', () => {
    expect(unexpectedIn(parseDiagnostics('error TS6053: File not found'))).toHaveLength(1);
  });

  test('a pinned gap is accepted and everything else is not', () => {
    expect(unexpectedIn([pinned])).toEqual([]);
    expect(unexpectedIn([{ ...pinned, code: 'TS2322' }])).toHaveLength(1);
    expect(unexpectedIn([{ ...pinned, file: 'apps/web/app/post/repo.ts' }])).toHaveLength(1);
    expect(unexpectedIn([{ ...pinned, message: "'row' is possibly 'undefined'." }])).toHaveLength(
      1,
    );
  });

  test('a pin is spent by one match, so a second identical diagnostic still fails the gate', () => {
    expect(unexpectedIn(allPinned)).toEqual([]);
    // Same file, same code, same message, one occurrence too many: a new regression hiding
    // behind an old bug is exactly what an unpinned count would wave through.
    expect(unexpectedIn([...allPinned, pinned])).toEqual([pinned]);
  });

  test('a gap that stops reproducing is reported, so a pin cannot outlive its bug', () => {
    expect(staleGapsIn(allPinned)).toEqual([]);
    expect(staleGapsIn([])).toEqual(KNOWN_GAPS);
    // One of the two pins on this file is satisfied; the other is not, and only it is stale.
    expect(staleGapsIn([pinned]).map((entry) => `${entry.file} ${entry.message}`)).not.toContain(
      `${pinned.file} ${pinned.message}`,
    );
  });

  test('every pinned gap names who fixes it, and the variant that reproduces it', () => {
    const names = scaffoldVariants().map((variant) => variant.name);
    for (const entry of KNOWN_GAPS) {
      expect(entry.owner.length).toBeGreaterThan(20);
      // A pin against a variant nobody compiles is a pin that can never go stale.
      expect(names).toContain(entry.variant);
    }
  });

  test('a pin is spent only by its own variant — another invocation cannot borrow it', () => {
    expect(gapsFor('x new')).toEqual(KNOWN_GAPS);
    expect(gapsFor('x new --no-example')).toEqual([]);
    // The same diagnostic, in a variant that pinned nothing, is a finding rather than a pass.
    expect(unexpectedIn([pinned], gapsFor('x new --no-example'))).toEqual([pinned]);
    expect(unexpectedIn([pinned], gapsFor('x new'))).toEqual([]);
  });

  test('a failed gate reads as a runnable bug report', () => {
    expect(formatDiagnostics([pinned])).toBe(
      "apps/web/app/post/entity.ts:20 TS18048: 'c.title' is possibly 'undefined'.",
    );
    expect(formatDiagnostics([{ file: '', line: 0, code: 'TS5083', message: 'bad' }])).toBe(
      'error TS5083: bad',
    );
  });

  test('a generated path may not escape the sandbox', () => {
    expect(sandboxPath('/tmp/x-scaffold-1', 'apps/web/site/page.tsx')).toBe(
      '/tmp/x-scaffold-1/apps/web/site/page.tsx',
    );
    for (const outside of ['../../target', '/etc/passwd', 'apps/../../outside.ts']) {
      expect(() => sandboxPath('/tmp/x-scaffold-1', outside)).toThrow(ScaffoldPathEscapeError);
    }
    // A sibling directory sharing the prefix is outside too — string prefixes are not paths.
    expect(() => sandboxPath('/tmp/x-scaffold-1', '../x-scaffold-12/a.ts')).toThrow(
      ScaffoldPathEscapeError,
    );
  });

  test('the fixture runs every generator on top of a whole scaffolded app', () => {
    const paths = scaffoldFixture().map((file) => file.path);
    expect(FIXTURE_GENERATORS.length).toBeGreaterThanOrEqual(9);
    expect(paths).toContain('app.config.ts');
    expect(paths).toContain('apps/web/app/invoice/actions/send-invoice.ts');
    // The admin override is a template no other invocation emits; unchecked, it drifts silently.
    expect(paths).toContain('apps/web/app/invoice/admin/resource.ts');
    // First write wins, exactly as `x g` resolves a file two generators both produce.
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('the fixture covers every generator `x g` offers, so none escapes the compiler', () => {
    expect([...new Set(FIXTURE_GENERATORS.map((options) => options.kind))].toSorted()).toEqual(
      [...GENERATORS].toSorted(),
    );
  });

  test('--no-example is its own variant: a different db package, so its own compile', () => {
    const [example, empty] = scaffoldVariants();
    expect(scaffoldVariants()).toHaveLength(2);
    const schemaIn = (variant: typeof example): string =>
      variant?.files.find((file) => file.path === 'packages/db/src/schema.ts')?.contents ?? '';
    // The bug this variant exists to catch: an entity re-export naming a slice nobody wrote.
    expect(schemaIn(example)).toContain("from '@ledger-demo/web/app/post/entity'");
    expect(schemaIn(empty)).not.toContain('app/post/entity');
    expect(empty?.files.some((file) => file.path.startsWith('apps/web/app/post/'))).toBe(false);
    for (const variant of scaffoldVariants()) expect(variant.why.length).toBeGreaterThan(20);
  });
});
