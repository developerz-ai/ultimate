// What every shape promises, read off its planned files: what it leaves out, that it names no
// provider or business rule (axiom 8), and that every path its CLAUDE.md points at is written.

import { describe, expect, test } from 'bun:test';
import { planNewApp } from '../../cmd-new';
import { NEW_SHAPES, type NewShape } from '../../new-shapes';
import type { GeneratedFile } from '../naming';
import { SHAPE_OVERLAYS } from './index';

const plan = (shape: NewShape): readonly GeneratedFile[] =>
  planNewApp({ name: 'probe', example: true, shape });

const text = (file: GeneratedFile): string =>
  typeof file.contents === 'string' ? file.contents : '';

/** A provider, its SDK, or a business rule a scaffold must never pick for its app. */
const BANNED =
  /\b(stripe|paddle|braintree|chargebee|lemon ?squeezy|paypal|openai|anthropic|gpt-\d|claude-\d)\b/i;

/** The text of one planned file, `''` when the plan has none — the assertion then says so. */
const textAt = (files: readonly GeneratedFile[], path: string): string => {
  const file = files.find((candidate) => candidate.path === path);
  return file === undefined ? '' : text(file);
};

const isPage = (path: string): boolean => /\/page\.tsx$/.test(path);
const isIsland = (path: string): boolean => path.includes('.island.');

describe('unit · x new --shape', () => {
  for (const shape of NEW_SHAPES) {
    test(`${shape}: no provider, no model id, no X_NOT_IMPLEMENTED`, () => {
      for (const file of plan(shape)) {
        expect({ path: file.path, banned: BANNED.exec(text(file))?.[0] }).toEqual({
          path: file.path,
          banned: undefined,
        });
        expect({ path: file.path, stub: text(file).includes('X_NOT_IMPLEMENTED') }).toEqual({
          path: file.path,
          stub: false,
        });
      }
    });

    test(`${shape}: every app path CLAUDE.md and README.md name is a file it writes`, () => {
      const files = plan(shape);
      const written = new Set(files.map((file) => file.path));
      for (const doc of files.filter((file) => /^(CLAUDE|README)\.md$/.test(file.path))) {
        for (const [path] of text(doc).matchAll(/(?<=`)apps\/[A-Za-z0-9_./[\]-]+\.[a-z]+(?=`)/g)) {
          expect({ doc: doc.path, path, written: written.has(path) }).toEqual({
            doc: doc.path,
            path,
            written: true,
          });
        }
      }
    });

    test(`${shape}: CLAUDE.md names the shape once, and README.md says what is next`, () => {
      const files = plan(shape);
      const claude = textAt(files, 'CLAUDE.md');
      expect(claude.split(`--shape ${shape}`).length - 1).toBe(1);
      const readme = textAt(files, 'README.md');
      expect(readme).toContain(`\`--shape ${shape}\``);
    });
  }

  test('blog: site/ is the only rendered surface, every page is 0kb, and no island ships', () => {
    const files = plan('blog');
    const pages = files.filter((file) => isPage(file.path));
    expect(pages.map((file) => file.path).sort()).toEqual([
      'apps/web/site/offline/page.tsx',
      'apps/web/site/page.tsx',
      'apps/web/site/posts/[slug]/page.tsx',
    ]);
    for (const page of pages)
      expect({ page: page.path, js: text(page).includes("js: '0kb'") }).toEqual({
        page: page.path,
        js: true,
      });
    expect(files.filter((file) => isIsland(file.path))).toEqual([]);
  });

  test('api: no page but the offline fallback, beside the error documents, and no island', () => {
    const files = plan('api');
    expect(files.filter((file) => isPage(file.path)).map((file) => file.path)).toEqual([
      'apps/web/site/offline/page.tsx',
    ]);
    expect(files.filter((file) => isIsland(file.path))).toEqual([]);
    expect(files.map((file) => file.path)).toContain('apps/web/site/errors/404.html');
  });

  test('api: the /v1 mount takes an org key, and OpenAPI is the complete document', () => {
    const index = textAt(plan('api'), 'apps/web/api/index.ts');
    expect(index).toContain("prefix: '/v1', scopes: API_KEY_SCOPES, resolveToken: resolveApiKey");
    expect(index).toContain("openapi: { title: 'Probe', version: '1.0.0' }");
  });

  test('dashboard: the default app plus a detail page each row links to, signed in by x g', () => {
    const files = plan('dashboard');
    const paths = files.map((file) => file.path);
    expect(paths).toContain('apps/web/app/posts/[id]/page.tsx');
    expect(paths).toContain('apps/web/app/post/queries/post-by-id.ts');
    expect(textAt(files, 'apps/web/app/posts/page.tsx')).toContain(
      '<a href={`/posts/$' + '{row.id}`}>',
    );
    expect(textAt(files, 'apps/web/api/index.ts')).toContain('queries: [postList, postById]');
    // Sign-in is the generator's own output, never re-spelled in the overlay.
    expect(SHAPE_OVERLAYS.dashboard.generate).toEqual([['sign-in', '--password']]);
    expect(paths.filter((path) => path.includes('/auth/sign-in/'))).toEqual([]);
    // Nothing of the default left out: an internal tool keeps the dashboard, the shell and /admin.
    const base = planNewApp({ name: 'probe', example: true }).map((file) => file.path);
    expect(base.filter((path) => !paths.includes(path))).toEqual([]);
  });

  test('a shape leaves the default scaffold untouched', () => {
    const before = planNewApp({ name: 'probe', example: true }).map((file) => file.path);
    for (const shape of NEW_SHAPES) plan(shape);
    expect(planNewApp({ name: 'probe', example: true }).map((file) => file.path)).toEqual(before);
  });
});
