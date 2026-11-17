// What `--shape content` promises, read off its planned files: `site/` is the only rendered surface
// and every page of it is 0 KB, its pages are files rather than rows, and both locales hold the
// same catalog keys and the same pages.

import { describe, expect, test } from 'bun:test';
import { clearAdminMounts, defineAdmin } from '@ultimat3/admin';
import { entity, uuid } from '@ultimat3/entity';
import { planNewApp } from '../../cmd-new';
import type { GeneratedFile } from '../naming';
import { CONTENT_LOCALES } from './content-pages';

const files = planNewApp({ name: 'probe', example: true, shape: 'content' });
const paths = files.map((file) => file.path);

const text = (path: string): string => {
  const contents = files.find((file) => file.path === path)?.contents;
  return typeof contents === 'string' ? contents : '';
};

/** A catalog's dotted keys, nested objects flattened as `flattenCatalog` does. */
const keysOf = (value: unknown, prefix = ''): readonly string[] =>
  typeof value === 'object' && value !== null
    ? Object.entries(value).flatMap(([key, child]) => keysOf(child, `${prefix}${key}.`))
    : [prefix.slice(0, -1)];

/**
 * What the mounted admin derives that names no table of the app's: its jobs dashboard, plus what
 * the app's FIRST entity adds (`admin.group.data`) — the next `x g entity` would leave Spanish
 * owing a key no generator writes, so `es` carries it from the start.
 */
/** A repo that answers nothing: only the keys are read, never a row. */
const NO_ROWS = {
  list: async () => [],
  find: async () => null,
  create: async () => ({}),
  update: async () => ({}),
  destroy: async () => {},
};

const generalAdminKeys = (): readonly string[] => {
  const probes = entity('probes', { columns: { id: uuid().primaryKey() } });
  const keys = [
    ...defineAdmin({ entities: [] }).catalogKeys(),
    ...defineAdmin({ entities: [probes], resources: { probes: { repo: NO_ROWS } } }).catalogKeys(),
  ];
  clearAdminMounts();
  return [...new Set(keys.filter((key) => !key.includes('probes')))].sort();
};

const isPage = (file: GeneratedFile): boolean => file.path.endsWith('/page.tsx');

describe('unit · x new --shape content', () => {
  test('site/ is the only rendered surface, and every page is static at 0 KB with no island', () => {
    const pages = files.filter(isPage);
    expect(pages.map((file) => file.path).sort()).toEqual([
      'apps/web/site/[page]/page.tsx',
      'apps/web/site/offline/page.tsx',
      'apps/web/site/page.tsx',
    ]);
    for (const page of pages) {
      const source = text(page.path);
      expect({ page: page.path, js: source.includes("js: '0kb'") }).toEqual({
        page: page.path,
        js: true,
      });
      expect({ page: page.path, isStatic: source.includes("render: 'static'") }).toEqual({
        page: page.path,
        isStatic: true,
      });
    }
    expect(paths.filter((path) => path.includes('.island.'))).toEqual([]);
  });

  test('its pages are files: no entity, no query, no seed row, and every locale has every page', () => {
    expect(paths.filter((path) => /\/(entity|repo)\.ts$|\/queries\//.test(path))).toEqual([]);
    const pagesOf = (locale: string): readonly string[] =>
      paths
        .filter((path) => path.startsWith(`apps/web/content/${locale}/`))
        .map((path) => path.slice(`apps/web/content/${locale}/`.length))
        .sort();
    const [first = 'en', ...rest] = CONTENT_LOCALES;
    expect(pagesOf(first).length).toBeGreaterThan(0);
    for (const locale of rest) expect(pagesOf(locale)).toEqual(pagesOf(first));
  });

  test('both locales are registered, and es holds every key en does and the admin derives', () => {
    const index = text('packages/i18n/src/index.ts');
    for (const locale of CONTENT_LOCALES) {
      expect(index).toContain(`import ${locale} from '../catalogs/${locale}.json';`);
    }
    const english = keysOf(JSON.parse(text('packages/i18n/catalogs/en.json')));
    const spanish = new Set(keysOf(JSON.parse(text('packages/i18n/catalogs/es.json'))));
    // The base scaffold's admin declares no entity: what it derives is the jobs dashboard alone.
    // English comes from the framework's own catalog; every other locale owes it (`i18n` step).
    const derived = generalAdminKeys();
    expect(english.length).toBeGreaterThan(0);
    expect(derived.length).toBeGreaterThan(0);
    expect([...english, ...derived].filter((key) => !spanish.has(key))).toEqual([]);
    // Nothing else: a key neither reads is a stale translation of a string that moved.
    const owed = new Set([...english, ...derived]);
    expect([...spanish].filter((key) => !owed.has(key))).toEqual([]);
  });

  test('the leave-outs: no dashboard, no shell, no theme toggle, no browser client', () => {
    for (const gone of [
      'apps/web/app/dashboard/',
      'apps/web/shared/shell',
      'apps/web/shared/theme-toggle',
      'apps/web/shared/browser-client',
    ]) {
      expect({ gone, kept: paths.filter((path) => path.startsWith(gone)) }).toEqual({
        gone,
        kept: [],
      });
    }
  });
});
