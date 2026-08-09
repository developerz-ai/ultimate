// The harness itself: diagnostic parsing, the fixture's shape, and the known-gap bookkeeping.
// Whether the scaffolded app actually compiles is the contract test next to this file.

import { describe, expect, test } from 'bun:test';
import {
  FIXTURE_GENERATORS,
  formatDiagnostics,
  KNOWN_GAPS,
  parseDiagnostics,
  scaffoldFixture,
  staleGapsIn,
  unexpectedIn,
} from './scaffold-typecheck';

const gap = { file: 'apps/web/app/post/entity.ts', line: 20, code: 'TS18048' } as const;
const pinned = { ...gap, message: "'c.title' is possibly 'undefined'." };

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

  test('a gap that stops reproducing is reported, so a pin cannot outlive its bug', () => {
    expect(staleGapsIn([pinned])).toEqual([]);
    expect(staleGapsIn([])).toEqual(KNOWN_GAPS);
  });

  test('every pinned gap names who fixes it', () => {
    for (const entry of KNOWN_GAPS) expect(entry.owner.length).toBeGreaterThan(20);
  });

  test('a failed gate reads as a runnable bug report', () => {
    expect(formatDiagnostics([pinned])).toBe(
      "apps/web/app/post/entity.ts:20 TS18048: 'c.title' is possibly 'undefined'.",
    );
    expect(formatDiagnostics([{ file: '', line: 0, code: 'TS5083', message: 'bad' }])).toBe(
      'error TS5083: bad',
    );
  });

  test('the fixture runs every generator on top of a whole scaffolded app', () => {
    const paths = scaffoldFixture().map((file) => file.path);
    expect(FIXTURE_GENERATORS.length).toBeGreaterThanOrEqual(9);
    expect(paths).toContain('app.config.ts');
    expect(paths).toContain('apps/web/app/invoice/actions/send-invoice.ts');
    // First write wins, exactly as `x g` resolves a file two generators both produce.
    expect(new Set(paths).size).toBe(paths.length);
  });
});
