// The generators' edit to `apps/web/api/index.ts`, against the index `x new` actually writes — with
// and without the example slice, because the two differ exactly in whether a `jobs:` list exists.

import { describe, expect, test } from 'bun:test';
import { apiEntriesFor, insertApiEntries } from './api-registration';
import { apiFiles } from './templates/scaffold-api';

const indexOf = (example: boolean): string =>
  String(apiFiles(example).find((file) => file.path === 'apps/web/api/index.ts')?.contents ?? '');

describe('unit · which written files are listed', () => {
  test('a job and a task are, their tests and everything else are not', () => {
    expect(
      apiEntriesFor([
        'apps/web/app/ping/jobs/ping.ts',
        'apps/web/app/ping/jobs/ping.job.test.ts',
        'apps/web/app/nightly/tasks/nightly.ts',
        'apps/web/app/post/actions/create-post.ts',
      ]),
    ).toEqual([
      { key: 'jobs', binding: 'ping', specifier: '../app/ping/jobs/ping' },
      { key: 'tasks', binding: 'nightly', specifier: '../app/nightly/tasks/nightly' },
    ]);
  });
});

describe('unit · inserting into the scaffolded index', () => {
  test('an index with no jobs list gains one after actions, and the import', () => {
    const entries = apiEntriesFor(['apps/web/app/ping/jobs/ping.ts']);
    const { source, skipped } = insertApiEntries(indexOf(false), entries);
    expect(skipped).toEqual([]);
    expect(source).toContain("import * as ping from '../app/ping/jobs/ping';\nimport * as health");
    expect(source).toContain('  actions: [health],\n  jobs: [ping],\n});');
  });

  test('an existing jobs list is extended, and the import sorts into the relative block', () => {
    const entries = apiEntriesFor(['apps/web/app/ping/jobs/ping.ts']);
    const { source } = insertApiEntries(indexOf(true), entries);
    expect(source).toContain('  jobs: [reindexPost, ping],');
    expect(source).toContain(
      "import * as ping from '../app/ping/jobs/ping';\nimport * as archivePost from '../app/post/",
    );
  });

  test('a second run changes nothing', () => {
    const entries = apiEntriesFor(['apps/web/app/ping/jobs/ping.ts']);
    const once = insertApiEntries(indexOf(true), entries).source;
    expect(insertApiEntries(once, entries).source).toBe(once);
  });

  test('an index that is not the scaffold shape is left alone', () => {
    const entries = apiEntriesFor(['apps/web/app/ping/jobs/ping.ts']);
    const foreign = 'export const api = {};\n';
    expect(insertApiEntries(foreign, entries)).toEqual({ source: foreign, skipped: entries });
  });
});
