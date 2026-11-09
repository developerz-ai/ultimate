// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures below are SOURCE TEXT — a
// `${…}` in one is the code under test, never an interpolation that went missing.
// The Postgres half of the resource page's test, as text: it installs the migrated database under
// the handle and asks the same sorted, paged list of it. Whether it PASSES is a scaffold's run.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { pageDbTest } from './resource-page-db';

const source = pageDbTest({
  feature: names('widget'),
  dir: 'apps/web/app/widget',
  pageDir: 'apps/web/app/widgets',
  shell: true,
  dbModule: '@acme/db',
});

describe('unit · the resource page over the migrated database', () => {
  test('the database is the app’s migrated one, installed under the handle and taken back', () => {
    expect(source).toContain(
      'const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));',
    );
    expect(source).toContain('setDbClient(await workerDatabase());');
    expect(source).toContain('afterAll(() => setDbClient(undefined));');
  });

  test('it asks the default order, then a title sort across two pages', () => {
    expect(source).toContain("const url = 'https://example.test/widgets';");
    expect(source).toContain('const sorted = `${url}?sort=title&dir=asc&limit=2`;');
    expect(source).toContain("expect(linkTo(second.html, 'next')).toBeUndefined();");
  });
});
