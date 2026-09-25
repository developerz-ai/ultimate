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

// Reproduced from an app: `x g task <name> --feature <slice>` writes the task AND its job, and the
// app's `jobs:` list was already one entry per line — which is the shape this edit itself produces
// once a list passes 100 columns. The line-start lookup landed on the first ITEM rather than on
// `jobs: [`, so the rewrite nested a second `jobs: [` inside the first and orphaned its `]`.
describe('unit · a list already wrapped one entry per line', () => {
  const WRAPPED = [
    "import { defineApi } from '@ultimat3/action';",
    "import * as anchorDayJob from '../app/evidence/jobs/anchor-day-job';",
    "import * as anchorDay from '../app/evidence/tasks/anchor-day';",
    "import * as health from './health';",
    '',
    'export const api = defineApi({',
    '  // Every primitive module under apps/web/app/*/{actions,queries,live,jobs,tasks}/, one entry each.',
    '  actions: [',
    '    health,',
    '  ],',
    '  jobs: [',
    '    anchorDayJob,',
    '    expireCreditsJob,',
    '  ],',
    '  tasks: [',
    '    anchorDay,',
    '  ],',
    '});',
    '',
  ].join('\n');

  test('a task and its job land in their lists, each list still one well-formed literal', () => {
    const entries = apiEntriesFor([
      'apps/web/app/billing/tasks/purge-drafts.ts',
      'apps/web/app/billing/jobs/purge-drafts-job.ts',
    ]);
    const { source, skipped } = insertApiEntries(WRAPPED, entries);

    expect(skipped).toEqual([]);
    expect(source.match(/jobs: \[/g)).toHaveLength(1);
    expect(source.match(/tasks: \[/g)).toHaveLength(1);
    expect(source).toContain('  jobs: [anchorDayJob, expireCreditsJob, purgeDraftsJob],\n');
    expect(source).toContain('  tasks: [anchorDay, purgeDrafts],\n');
    expect(source).toContain('  actions: [\n    health,\n  ],\n');
    expect(source.endsWith('});\n')).toBe(true);
    // And it stays that way: the next run finds both names and changes nothing.
    expect(insertApiEntries(source, entries).source).toBe(source);
  });

  // The scaffold's own index, grown one job at a time past the 100-column wrap — the shape every
  // app reaches on its own, with nothing but this generator writing the list.
  test('growing the scaffold index one job at a time keeps one jobs list, every job in it', () => {
    const names = [
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'foxtrot',
      'golf',
      'hotel',
      'india',
      'juliet',
      'kilo',
      'lima',
    ];
    let source = indexOf(true);
    for (const name of names) {
      source = insertApiEntries(
        source,
        apiEntriesFor([`apps/web/app/${name}-slice/jobs/${name}-job.ts`]),
      ).source;
    }
    expect(source.match(/jobs: \[/g)).toHaveLength(1);
    const list = /jobs: \[(?<body>[^\]]*)\]/.exec(source)?.groups?.['body'] ?? '';
    for (const name of names) expect(list).toContain(`${name}Job`);
    expect(list).toContain('reindexPost');
  });
});
