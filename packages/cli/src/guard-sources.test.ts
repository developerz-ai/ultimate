// What sharing one read has to guarantee: sixteen guards over one tree is one walk per glob and
// one compile per stylesheet, and a guard handed a text it did not ask the disk for still gets the
// text that is on disk.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; `mkdtemp`/`rm` own a throwaway app root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { guardSources } from './guard-sources';
import { GUARD_DIR, guardFindings } from './guards';

const withApp = async (
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-guard-sources-'));
  try {
    for (const [path, contents] of Object.entries(files))
      await Bun.write(join(root, path), contents);
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('unit · guard sources · one read of the app per gate run', () => {
  test('files() answers app-root-relative paths, sorted, with their text', async () => {
    await withApp(
      { 'apps/web/b.module.scss': '.b{}', 'apps/web/a.module.scss': '.a{}', 'apps/web/a.tsx': 'x' },
      async (root) => {
        expect(await guardSources(root).files('apps/**/*.scss')).toEqual([
          { path: 'apps/web/a.module.scss', text: '.a{}' },
          { path: 'apps/web/b.module.scss', text: '.b{}' },
        ]);
      },
    );
  });

  test('a seeded path is the text the step already read — never a second read of the disk', async () => {
    await withApp(
      { 'apps/web/app/a.ts': 'on disk', 'apps/web/app/b.ts': 'also on disk' },
      async (root) => {
        const sources = guardSources(root, [{ path: 'apps/web/app/a.ts', source: 'already read' }]);
        expect(await sources.files('apps/**/*.ts')).toEqual([
          { path: 'apps/web/app/a.ts', text: 'already read' },
          { path: 'apps/web/app/b.ts', text: 'also on disk' },
        ]);
      },
    );
  });

  test('a dependency, a build output and a cache are never the app', async () => {
    await withApp(
      {
        'apps/web/node_modules/pkg/x.scss': '.x{}',
        'apps/web/.x/static/x.scss': '.x{}',
        'packages/ui/dist/x.scss': '.x{}',
        'apps/web/kept.scss': '.kept{}',
      },
      async (root) => {
        const found = await guardSources(root).files('{apps,packages}/**/*.scss');
        expect(found.map((file) => file.path)).toEqual(['apps/web/kept.scss']);
      },
    );
  });

  // The property the seam exists for. A second ask is the SAME list — not an equal one — so a
  // second guard asking for the stylesheets costs no walk and no read.
  test('the same glob asked twice is one walk, and two globs share each file they both match', async () => {
    await withApp({ 'apps/web/a.module.scss': '.a{}' }, async (root) => {
      const sources = guardSources(root);
      const first = await sources.files('apps/**/*.scss');
      expect(await sources.files('apps/**/*.scss')).toBe(first);
      await Bun.write(join(root, 'apps/web/a.module.scss'), '.changed{}');
      // A different glob over the same file: the text is the one already read this run.
      expect((await sources.files('apps/web/*.scss'))[0]?.text).toBe('.a{}');
    });
  });

  test('compiled() answers the CSS and the class map the build would, once', async () => {
    await withApp(
      { 'apps/web/card.module.scss': '.card { &-title { color: inherit; } }\n' },
      async (root) => {
        const sources = guardSources(root);
        const sheet = await sources.compiled('apps/web/card.module.scss');
        expect(Object.keys(sheet?.classes ?? {})).toEqual(['card-title']);
        expect(sheet?.css).toContain('color:inherit');
        expect(await sources.compiled('apps/web/card.module.scss')).toBe(sheet);
      },
    );
  });

  // Not a finding and not a throw: a sheet that does not compile is the BUILD's refusal
  // (`X_PRERENDER_FAILED`, naming the Sass error); a guard that also reported it would say the
  // same thing twice, under a code about something else.
  test('a stylesheet that does not compile, or does not exist, is undefined', async () => {
    await withApp({ 'apps/web/bad.module.scss': '.a { color: ; ' }, async (root) => {
      const sources = guardSources(root);
      expect(await sources.compiled('apps/web/bad.module.scss')).toBeUndefined();
      expect(await sources.compiled('apps/web/absent.module.scss')).toBeUndefined();
    });
  });

  test('every guard in one run is handed the SAME sources', async () => {
    const guard = (name: string): string =>
      [
        'export const guard = {',
        `  summary: '${name}',`,
        '  async check(root, sources) {',
        "    const files = await sources.files('apps/**/*.scss');",
        '    globalThis.__seen = [...(globalThis.__seen ?? []), files];',
        '    return [];',
        '  },',
        '};',
        '',
      ].join('\n');
    await withApp(
      {
        [`${GUARD_DIR}/one.ts`]: guard('one'),
        [`${GUARD_DIR}/two.ts`]: guard('two'),
        'apps/web/a.module.scss': '.a{}',
      },
      async (root) => {
        const holder = globalThis as { __seen?: unknown[] };
        holder.__seen = [];
        expect(await guardFindings(root)).toEqual([]);
        expect(holder.__seen).toHaveLength(2);
        expect(holder.__seen[0]).toBe(holder.__seen[1]);
        holder.__seen = undefined as never;
      },
    );
  });
});
