import { describe, expect, test } from 'bun:test';
import { SUPERSEDED_WORKAROUNDS } from './superseded';
import { commentBlocks, matchSuperseded } from './superseded-match';

const ids = (path: string, text: string): readonly string[] =>
  matchSuperseded(path, text, SUPERSEDED_WORKAROUNDS).map((hit) => hit.id);

const page = (comment: string, mode: string): string =>
  [
    "import { defineRoute } from '@ultimat3/render';",
    '',
    'export const config = defineRoute({',
    comment,
    `  render: '${mode}',`,
    "  hydrate: 'visible',",
    '});',
  ].join('\n');

describe('unit · comment blocks', () => {
  test('consecutive comment lines are one block; code ends it', () => {
    const blocks = commentBlocks('a.ts', '// one\n// two\nconst x = 1;\n/** three\n * four */');
    expect(blocks.map((block) => [block.start, block.end, block.text])).toEqual([
      [1, 2, 'one two'],
      [4, 5, 'three four */'],
    ]);
  });

  test('markdown is prose: each paragraph is a block', () => {
    const blocks = commentBlocks('docs/gaps.md', '# Gaps\n\nline a\nline b\n\nline c');
    expect(blocks.map((block) => block.text)).toEqual(['# Gaps', 'line a line b', 'line c']);
  });
});

describe('unit · ssr-until-hole', () => {
  test('the note beside render: ssr is the workaround', () => {
    const text = page("  // 'ssr' until a hole marker ships", 'ssr');
    expect(matchSuperseded('apps/web/app/page.tsx', text, SUPERSEDED_WORKAROUNDS)).toEqual([
      { id: 'ssr-until-hole', at: 'apps/web/app/page.tsx:4' },
    ]);
  });

  test('a note wrapped over two lines still names it', () => {
    expect(ids('p.tsx', page('  // waits until a hole\n  // marker ships', 'ssr'))).toEqual([
      'ssr-until-hole',
    ]);
  });

  test('the same note on a stream page is history, not a workaround', () => {
    expect(ids('p.tsx', page('  // was ssr until a hole marker shipped', 'stream'))).toEqual([]);
  });

  test('an ordinary ssr page is never a hit: the note is what names the workaround', () => {
    expect(ids('p.tsx', page('  // per-request: the rows are the actor’s', 'ssr'))).toEqual([]);
  });

  test("a note quoting render: 'ssr' is not the page declaring it", () => {
    const text = "// no hole marker yet, so pages say render: 'ssr'\nexport const a = 1;";
    expect(ids('p.tsx', text)).toEqual([]);
  });

  test('prose quoting the workaround is not holding it: markdown has no page to declare', () => {
    const text = 'Apps keep `render: \'ssr\'` "until a hole marker ships".';
    expect(ids('docs/notes.md', text)).toEqual([]);
  });

  test('a trailing comment on the declaration line counts', () => {
    const text = "defineRoute({\n  render: 'ssr', // until a hole marker ships\n});";
    expect(ids('p.tsx', text)).toEqual(['ssr-until-hole']);
  });
});

describe('unit · token-unimplemented', () => {
  test('a header saying x token is unimplemented', () => {
    const text = '// Mints a CLI key by hand: `x token` is unimplemented.\nexport const a = 1;';
    expect(ids('apps/web/app/keys/mint.ts', text)).toEqual(['token-unimplemented']);
  });

  test('a note that uses x token is not one', () => {
    expect(ids('a.ts', '// x token create mints the key this reads\nexport const a = 1;')).toEqual(
      [],
    );
  });

  test('x token grant is still planned: a note saying so is true, not a workaround', () => {
    const text =
      '// Not `x token grant`: that command is planned and exits X_NOT_IMPLEMENTED.\nf();';
    expect(ids('a.test.ts', text)).toEqual([]);
  });

  test('history in the past tense is not a workaround', () => {
    const text = '- `x token create` and `x config show` ship (they exited `X_NOT_IMPLEMENTED`).';
    expect(ids('docs/changelog/31.17.0.md', text)).toEqual([]);
  });

  test('code is never read: only the comment names a workaround', () => {
    expect(ids('a.ts', "const note = 'x token is not implemented';")).toEqual([]);
  });
});

describe('unit · verify-no-only', () => {
  test('a gaps line saying the gate has no --only', () => {
    expect(ids('docs/gaps.md', '- the gate has no `--only`, so CI runs all of it')).toEqual([
      'verify-no-only',
    ]);
  });

  test('a fixture that carries no --only is not a claim about the gate', () => {
    const text =
      '// `verify` declares no flags here, so the fixture carries no `--only` either.\nf();';
    expect(ids('a.test.ts', text)).toEqual([]);
  });

  test('a line using --only is not one', () => {
    expect(ids('docs/ci.md', 'CI runs `x verify --only lint`, with no network')).toEqual([]);
  });
});

describe('unit · dev-no-tls', () => {
  test('a terminator whose header says x dev has no TLS', () => {
    const text = '// x dev has no TLS, so this terminates https for the tablet.\nBun.serve({});';
    expect(ids('bin/serve-https.ts', text)).toEqual(['dev-no-tls']);
  });

  test('a note using x dev --tls is not one', () => {
    expect(ids('a.ts', '// x dev --tls serves this over https\nexport const a = 1;')).toEqual([]);
  });
});
