// A source comment that promises a removal at the next major is a parked break, so it must be a
// `PARKED_BREAKS` row: the tag sites are read, each must name a row's `removes`, and a row's
// removal must still name a declaration in its file.

import { describe, expect, test } from 'bun:test';
import type { ParkedBreak } from './next-breaks-list';
import { declarationLine, parkedTagsIn, unparkedTags, untaggedRemovals } from './next-breaks-tags';

const SOURCE = [
  '// a file',
  '/** @deprecated Use bar() — removed at the next major. */',
  'export function foo(): void {}',
  '',
  'export interface Options {',
  '  /**',
  '   * @deprecated Pass `clock`. An alias until the next major.',
  '   */',
  '  readonly now?: Date;',
  '  /** @deprecated Use `clock`; kept for good. */',
  '  readonly when?: Date;',
  '}',
  '',
  '/**',
  ' * Read, never written. Delete with the fallback below in 32.0.0.',
  ' */',
  "const LEGACY = '__Host-x';",
  '',
  '// Deleted in 25.0.0, and a prerelease is 32.0.0-next.1: neither is a promise.',
  'export const kept = 1;',
].join('\n');

const ROW: ParkedBreak = {
  ids: 'Z9',
  title: 'foo goes',
  change: 'bar() is the one way',
  sources: [],
  removes: [{ path: 'packages/z/src/a.ts', symbol: 'foo' }],
};

describe('unit · next-breaks-tags · which comments promise a removal at the next major', () => {
  test('`@deprecated` naming the next major, and any comment naming a later major', () => {
    expect(parkedTagsIn('packages/z/src/a.ts', SOURCE, 31)).toEqual([
      { path: 'packages/z/src/a.ts', line: 2, symbol: 'foo' },
      { path: 'packages/z/src/a.ts', line: 7, symbol: 'now' },
      { path: 'packages/z/src/a.ts', line: 15, symbol: 'LEGACY' },
    ]);
  });

  test('a major already current is history, not a promise', () => {
    const sites = parkedTagsIn('packages/z/src/a.ts', SOURCE, 32);
    expect(sites.map((site) => site.symbol)).toEqual(['foo', 'now']);
  });

  test('a tag above no declaration is a site with no symbol', () => {
    const text = '/** @deprecated removed at the next major. */\n\nfoo();\n';
    expect(parkedTagsIn('packages/z/src/b.ts', text, 31)).toEqual([
      { path: 'packages/z/src/b.ts', line: 1, symbol: undefined },
    ]);
  });
});

describe('unit · next-breaks-tags · a tagged symbol no row removes is refused', () => {
  test('the unlisted tags refuse, each fix naming the row to add; the listed one passes', () => {
    const sites = parkedTagsIn('packages/z/src/a.ts', SOURCE, 31);
    const findings = unparkedTags(sites, [ROW], 'x\nexport const PARKED_BREAKS');
    expect(findings.map((finding) => finding.code)).toEqual([
      'X_NEXT_BREAK_UNPARKED',
      'X_NEXT_BREAK_UNPARKED',
    ]);
    expect(findings[0]?.at).toBe('packages/z/src/a.ts:7');
    expect(findings[0]?.fix).toStartWith('edit scripts/lib/next-breaks-list.ts:2 — ');
    expect(findings[0]?.fix).toContain("{ path: 'packages/z/src/a.ts', symbol: 'now' }");
    expect(findings[1]?.fix).toContain("symbol: 'LEGACY'");
    expect(unparkedTags(sites.slice(0, 1), [ROW])).toEqual([]);
  });

  test('the same symbol in another file is not the listed one', () => {
    const moved = { path: 'packages/z/src/other.ts', line: 2, symbol: 'foo' };
    expect(unparkedTags([moved], [ROW]).map((finding) => finding.code)).toEqual([
      'X_NEXT_BREAK_UNPARKED',
    ]);
  });

  test('a tag above no declaration refuses at the tag, never at the list', () => {
    const [finding] = unparkedTags(
      [{ path: 'packages/z/src/b.ts', line: 1, symbol: undefined }],
      [],
    );
    expect(finding?.code).toBe('X_NEXT_BREAK_UNPARKED');
    expect(finding?.fix).toStartWith('bun run scripts/next-breaks.ts --json');
    expect(finding?.fix).toContain('packages/z/src/b.ts:1');
  });
});

describe('unit · next-breaks-tags · a row removal is a declaration, tagged or owed', () => {
  test('the declaration line of a function, a const and a member; none for a call', () => {
    expect(declarationLine(SOURCE, 'foo')).toBe(3);
    expect(declarationLine(SOURCE, 'now')).toBe(9);
    expect(declarationLine(SOURCE, 'LEGACY')).toBe(17);
    expect(declarationLine('foo();\nconst x = foo;\n', 'foo')).toBeUndefined();
  });

  test('a removal with no tag at its file and symbol is owed one', () => {
    const tagged = [{ path: 'packages/z/src/a.ts', line: 2, symbol: 'foo' }];
    const row: ParkedBreak = {
      ...ROW,
      removes: [...(ROW.removes ?? []), { path: 'packages/z/src/a.ts', symbol: 'kept' }],
    };
    expect(untaggedRemovals(tagged, [row])).toEqual([
      { path: 'packages/z/src/a.ts', symbol: 'kept' },
    ]);
  });
});
