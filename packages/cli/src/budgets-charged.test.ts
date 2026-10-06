// `X_BUDGET_EXCEEDED` names every file it charged and its exact bytes, and the measurer weighs a
// URL at the path a browser resolves it to. Both exist for one report: the Windows job read
// `/posts` at 82,161 B while Linux read 60,704 B, and the finding's one line — the heaviest file's
// name — could not say whether a chunk was heavier or a byte was counted twice.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { RouteFact } from '@ultimat3/manifest';
import { buildManifest } from '@ultimat3/manifest';
import { themeScriptBody } from '@ultimat3/render';
import type { RouteStats } from './budgets';
import { checkBudgets, measureDocumentJs, routeStatsRow } from './budgets';
import { processRoot } from './process-root-fixture';

const dirFor = (name: string): string =>
  processRoot(
    join(tmpdir(), `x-budget-charged-${Bun.hash(`${import.meta.path}:${name}`).toString(16)}`),
  );

const manifestOf = (...routes: readonly RouteFact[]) =>
  buildManifest({ app: { name: 'fixture', version: '1.0.0' }, routes });

const posts: RouteFact = { url: '/posts', render: 'ssr', budget: { js: '64kb' } };

/** The Windows job's row, as the build will now write it. */
const windowsRow: RouteStats = {
  path: '/posts',
  jsBytes: 82_161,
  frameworkJsBytes: 813,
  heaviestChain: ['apps/web/app/post/post-form.island.tsx'],
  charged: [{ url: '/islands/post-form-04f75f18.js', bytes: 81_306 }],
  inlineJsBytes: 855,
};

const exceeded = (row: RouteStats) =>
  checkBudgets(manifestOf(posts), { routes: [row] }, [], () => 'apps/web/app/posts/page.tsx')[0];

describe('unit · X_BUDGET_EXCEEDED names what it charged', () => {
  test('the cause lists each charged file with its exact bytes, and the inline scripts', () => {
    const finding = exceeded(windowsRow);
    expect(finding?.code).toBe('X_BUDGET_EXCEEDED');
    expect(finding?.cause).toContain('via apps/web/app/post/post-form.island.tsx');
    expect(finding?.cause).toContain(
      'charged: /islands/post-form-04f75f18.js 81306 B, inline scripts 855 B',
    );
  });

  test('--json carries the same facts as data, so no reader parses the sentence', () => {
    expect(exceeded(windowsRow)?.meta).toEqual({
      jsBytes: 82_161,
      charged: [{ url: '/islands/post-form-04f75f18.js', bytes: 81_306 }],
      inlineJsBytes: 855,
    });
  });

  test('past five files the rest are summed, never dropped', () => {
    const charged = Array.from({ length: 7 }, (_, i) => ({ url: `/c${String(i)}.js`, bytes: 10 }));
    const cause = exceeded({ ...windowsRow, charged, inlineJsBytes: 0 })?.cause ?? '';
    expect(cause).toContain('/c4.js 10 B, 2 more files 20 B');
    expect(cause).not.toContain('/c5.js');
    expect(cause).not.toContain('inline scripts');
  });

  test('a row an older build wrote, with no breakdown, keeps the sentence it always had', () => {
    const { charged: _c, inlineJsBytes: _i, ...older } = windowsRow;
    const finding = exceeded(older);
    expect(finding?.cause.endsWith('via apps/web/app/post/post-form.island.tsx')).toBe(true);
    expect(finding?.meta).toBeUndefined();
  });
});

describe('unit · routeStatsRow records the breakdown the finding reads', () => {
  test('every charged file, heaviest first, and the app`s inline bytes', async () => {
    const dir = dirFor('row');
    await Bun.write(join(dir, 'small.js'), 'a');
    await Bun.write(join(dir, 'big.js'), 'abcdef');
    const html =
      `<script>${themeScriptBody({ fallback: 'system' })}</script>` +
      '<script>let a=1</script><script src="/small.js"></script><script src="/big.js"></script>';
    const measured = await measureDocumentJs(html, dir);
    expect(measured.inlineBytes).toBe('let a=1'.length);

    expect(routeStatsRow('/x', measured, ['big.ts'])).toEqual({
      path: '/x',
      jsBytes: 1 + 6 + 'let a=1'.length,
      frameworkJsBytes: Buffer.byteLength(themeScriptBody({ fallback: 'system' }), 'utf8'),
      heaviestChain: ['big.ts'],
      charged: [
        { url: '/big.js', bytes: 6 },
        { url: '/small.js', bytes: 1 },
      ],
      inlineJsBytes: 'let a=1'.length,
    });
  });
});

describe('unit · a URL is weighed at the path the browser resolves it to', () => {
  // A browser parses `src` with the WHATWG URL parser, which reads `\` as `/` in an http(s) URL —
  // so `/islands\x.js` is the SAME fetch as `/islands/x.js`. Keyed by the raw string, the dedupe
  // saw two files, and on Windows `join` turned both spellings into one real path: charged twice.
  test('a backslash spelling of a URL already charged is the same fetch, charged once', async () => {
    const dir = dirFor('backslash');
    await Bun.write(join(dir, 'islands/post-form-1.js'), 'console.log(1)');
    const measured = await measureDocumentJs(
      '<div data-x-entry="/islands/post-form-1.js"></div>' +
        '<div data-x-entry="/islands\\post-form-1.js"></div>',
      dir,
    );
    expect(measured.entries).toEqual([{ url: '/islands/post-form-1.js', bytes: 14 }]);
    expect(measured.jsBytes).toBe(14);
  });

  test('`./` and `..` segments are the path they resolve to, not a second file', async () => {
    const dir = dirFor('dots');
    await Bun.write(join(dir, 'islands/a.js'), 'console.log(1)');
    const measured = await measureDocumentJs(
      '<script src="/islands/a.js"></script><script src="/islands/./x/../a.js"></script>',
      dir,
    );
    expect(measured.entries).toEqual([{ url: '/islands/a.js', bytes: 14 }]);
  });

  test('a protocol-relative src is another origin, never a file of this artifact', async () => {
    const dir = dirFor('protocol-relative');
    await Bun.write(join(dir, 'cdn.test/a.js'), 'console.log(1)');
    const measured = await measureDocumentJs('<script src="//cdn.test/a.js"></script>', dir);
    expect(measured.entries).toEqual([]);
    expect(measured.jsBytes).toBe(0);
  });
});
