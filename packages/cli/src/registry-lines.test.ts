// The registries' one-entry-per-line shape: what `x new` writes, what the codemod leaves, and that
// a generator's next edit lands as one added line — the property the merge driver depends on.

import { describe, expect, test } from 'bun:test';
import { insertApiEntries } from './api-registration';
import { planNewApp } from './cmd-new';
import { editExerciseFile } from './exercise-entry-edit';
import { insertGrants } from './generate-grants';
import { insertHandleEntries } from './handle-registration';
import { NEW_SHAPES } from './new-shapes';
import { REGISTRY_FILES, REGISTRY_LINE_COMMENT, withRegistryLines } from './registry-lines';

const API = 'apps/web/api/index.ts';
const ROLES = 'apps/web/shared/roles.ts';
const EXERCISE = 'apps/web/exercise.ts';
const CLIENT = 'packages/db/src/client.ts';

const planned = (path: string, example = true): string => {
  const file = planNewApp({ name: 'demo', example }).find((one) => one.path === path);
  if (typeof file?.contents !== 'string') expect.unreachable(`x new writes no ${path}`);
  return file.contents;
};

/** The lines `after` has that `before` lacks; fails when `before` lost or changed any line. */
const addedLines = (before: string, after: string): readonly string[] => {
  const rest = after.split('\n');
  for (const line of before.split('\n')) {
    const at = rest.indexOf(line);
    if (at === -1) expect.unreachable(`the edit changed an existing line: ${line}`);
    rest.splice(at, 1);
  }
  return rest;
};

describe('unit · x new writes every registry one entry per line', () => {
  test('each list of the API index is expanded, and tasks exists before anyone adds one', () => {
    const source = planned(API);
    expect(source).toContain(`  actions: [\n    ${REGISTRY_LINE_COMMENT}\n    health,\n`);
    expect(source).toContain(`  tasks: [\n    ${REGISTRY_LINE_COMMENT}\n  ],`);
    expect(source).not.toContain('actions: [health');
  });

  test("a role's short grants list is expanded too", () => {
    expect(planned(ROLES)).toContain(
      `grants: [\n      ${REGISTRY_LINE_COMMENT}\n      'dashboard:read',\n      'post:read',\n    ],`,
    );
  });

  test('the bare app opens its two empty object registries', () => {
    expect(planned(EXERCISE, false)).toContain(`defineExercise({\n  ${REGISTRY_LINE_COMMENT}\n});`);
    expect(planned(CLIENT, false)).toContain(`const entities = {\n  ${REGISTRY_LINE_COMMENT}\n};`);
  });

  test('every shape still applies its edits and ends in the same shape', () => {
    for (const shape of NEW_SHAPES) {
      const file = planNewApp({ name: 'demo', example: true, shape }).find((f) => f.path === API);
      expect(String(file?.contents)).toContain(`actions: [\n    ${REGISTRY_LINE_COMMENT}`);
    }
  });
});

describe('unit · a generator edit is one added line', () => {
  test('defineApi: the import and the list entry, nothing rewritten', () => {
    const before = planned(API);
    const { source } = insertApiEntries(before, [
      { key: 'jobs', binding: 'reindexAlpha', specifier: '../app/alpha/jobs/reindex-alpha' },
    ]);
    expect([...addedLines(before, source)].sort()).toEqual([
      '    reindexAlpha,',
      "import * as reindexAlpha from '../app/alpha/jobs/reindex-alpha';",
    ]);
  });

  test('roles: a grant into a list that used to fit on one line', () => {
    const before = planned(ROLES);
    const { source } = insertGrants(before, [{ role: 'member', permission: 'alpha:read' }]);
    expect(addedLines(before, source)).toEqual(["      'alpha:read',"]);
  });

  test('the handle and the exercise file gain rows inside their opened empty object', () => {
    const client = planned(CLIENT, false);
    const entry = { key: 'alphas', binding: 'alpha', specifier: '@demo/web/app/alpha/entity' };
    expect([...addedLines(client, insertHandleEntries(client, [entry]).source)].sort()).toEqual([
      '  alphas: alpha,',
      "import { alpha } from '@demo/web/app/alpha/entity';",
    ]);
    const exercise = planned(EXERCISE, false);
    const edit = editExerciseFile(exercise, [{ name: 'createAlpha', value: "{ off: 'why' }" }]);
    expect(edit.kind === 'edited' && addedLines(exercise, edit.source)).toEqual([
      "  createAlpha: { off: 'why' },",
    ]);
  });
});

describe('unit · withRegistryLines over an existing app', () => {
  test('is idempotent on every registry', () => {
    for (const path of REGISTRY_FILES) {
      const once = planned(path);
      expect(withRegistryLines(path, once)).toBe(once);
    }
  });

  test('a list already over several lines only gains the comment', () => {
    const source = `const r = defineRoles({\n  admin: {\n    grants: [\n      'a:b', // kept\n      'c:d',\n    ],\n  },\n});\n`;
    expect(withRegistryLines(ROLES, source)).toBe(
      `const r = defineRoles({\n  admin: {\n    grants: [\n      ${REGISTRY_LINE_COMMENT}\n      'a:b', // kept\n      'c:d',\n    ],\n  },\n});\n`,
    );
  });

  test("a one-line list holding the author's comment is left alone", () => {
    const source = `const r = defineRoles({\n  admin: { grants: ['a:b' /* why */] },\n});\n`;
    expect(withRegistryLines(ROLES, source)).toBe(source);
  });

  // notificado.co's 31.49.0 upgrade: `queries, jobs, tasks` shorthand gained `queries: []` beside
  // each — a duplicate key, TS1117.
  test('a shorthand or non-list property is declared already: no second key is written', () => {
    const source = [
      "import { defineApi } from '@ultimat3/action';",
      "import * as actions from './actions';",
      "import { jobs, queries, tasks } from './more';",
      '',
      'export const api = defineApi({',
      '  actions: [actions],',
      '  queries,',
      "  'jobs': jobs,",
      '  tasks,',
      '});',
      '',
    ].join('\n');
    const after = withRegistryLines(API, source);
    for (const key of ['queries', 'jobs', 'tasks']) {
      expect(after.match(new RegExp(`\\b${key}\\b\\s*:`, 'g'))?.length ?? 0).toBe(
        key === 'jobs' ? 1 : 0,
      );
    }
    expect(after).toContain('  queries,\n');
    expect(after).toContain(`  actions: [\n    ${REGISTRY_LINE_COMMENT}\n    actions,\n  ],`);
  });

  test('any other file is untouched', () => {
    expect(withRegistryLines('apps/web/other.ts', 'const a = [1, 2];\n')).toBe(
      'const a = [1, 2];\n',
    );
  });
});
