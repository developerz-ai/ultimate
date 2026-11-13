// `x g`'s edit of apps/web/exercise.ts: an entry inserted into the one `defineExercise({ … })`,
// printed the way Biome leaves it, its import added in Biome's order, never twice, and a file the
// edit cannot read refused — never guessed at.

import { describe, expect, test } from 'bun:test';
import type { ExerciseEntry } from './exercise-entry-edit';
import { editExerciseFile } from './exercise-entry-edit';

const WRITER: ExerciseEntry = {
  name: 'writeArticle',
  value: "{\n  actor: userActor({ id: 'member', permissions: ['blog:write'] }),\n}",
  imports: [{ name: 'userActor', from: '@ultimat3/core' }],
};

const SCAFFOLD = [
  '// header',
  "import { defineExercise } from '@ultimat3/testing';",
  '',
  'export const exercise = defineExercise({});',
  '',
].join('\n');

const edited = (source: string | undefined, entries: readonly ExerciseEntry[]): string => {
  const result = editExerciseFile(source, entries);
  if (result.kind === 'refused') return expect.unreachable(`refused: ${result.reason}`);
  return result.source;
};

describe('unit · the exercise file edit', () => {
  test('the scaffold’s empty call gains the entry and its import, sorted', () => {
    expect(edited(SCAFFOLD, [WRITER])).toBe(
      [
        '// header',
        "import { userActor } from '@ultimat3/core';",
        "import { defineExercise } from '@ultimat3/testing';",
        '',
        'export const exercise = defineExercise({',
        '  writeArticle: {',
        "    actor: userActor({ id: 'member', permissions: ['blog:write'] }),",
        '  },',
        '});',
        '',
      ].join('\n'),
    );
  });

  // A job is registered by its pinned kebab name: unquoted, `billing-events: {` is a syntax error.
  test('a name that is no identifier is written quoted, and read back as already there', () => {
    const job: ExerciseEntry = { name: 'billing-events', value: '{ actor: null }' };
    const once = edited(SCAFFOLD, [job]);
    expect(once).toContain("  'billing-events': { actor: null },");
    expect(editExerciseFile(once, [job])).toEqual({ kind: 'unchanged', source: once });
  });

  test('a second run changes nothing: an entry the file names is the app’s', () => {
    const once = edited(SCAFFOLD, [WRITER]);
    const again = editExerciseFile(once, [WRITER]);
    expect(again).toEqual({ kind: 'unchanged', source: once });
    const own = SCAFFOLD.replace('({})', "({ writeArticle: { off: 'mine' } })");
    expect(editExerciseFile(own, [WRITER])).toEqual({ kind: 'unchanged', source: own });
  });

  test('an existing import from the module gains the name, in Biome’s order', () => {
    const source = SCAFFOLD.replace(
      "import { defineExercise } from '@ultimat3/testing';",
      "import { useContext } from '@ultimat3/core';\nimport { defineExercise } from '@ultimat3/testing';",
    );
    expect(edited(source, [WRITER])).toContain(
      "import { useContext, userActor } from '@ultimat3/core';",
    );
  });

  test('an object over several lines, under an indent, gains its last row at that indent', () => {
    const source = [
      "import { userActor } from '@ultimat3/core';",
      "import { defineExercise } from '@ultimat3/testing';",
      '',
      'export const exercise = defineExercise(',
      '  {',
      '    // why',
      "    keep: { off: 'a reason' } // no comma",
      '  },',
      '  { actor: members },',
      ');',
      '',
    ].join('\n');
    expect(edited(source, [WRITER])).toBe(
      [
        "import { userActor } from '@ultimat3/core';",
        "import { defineExercise } from '@ultimat3/testing';",
        '',
        'export const exercise = defineExercise(',
        '  {',
        '    // why',
        "    keep: { off: 'a reason' }, // no comma",
        '    writeArticle: {',
        "      actor: userActor({ id: 'member', permissions: ['blog:write'] }),",
        '    },',
        '  },',
        '  { actor: members },',
        ');',
        '',
      ].join('\n'),
    );
  });

  test('a one-line object with entries is expanded, a row each', () => {
    const source = SCAFFOLD.replace('({})', "({ keep: { off: 'a reason' } })");
    expect(edited(source, [{ name: 'other', value: "{ off: 'n/a' }" }])).toContain(
      "defineExercise({\n  keep: { off: 'a reason' },\n  other: { off: 'n/a' },\n});",
    );
  });

  test('no file starts from x new’s', () => {
    const out = edited(undefined, [WRITER]);
    expect(out).toContain("import { defineExercise } from '@ultimat3/testing';");
    expect(out).toContain('  writeArticle: {');
  });

  test.each([
    ['no call', 'export const exercise = makeMine();\n', 'no defineExercise() call'],
    [
      'two calls',
      'export const exercise = defineExercise({});\nexport const b = defineExercise({});\n',
      '2 defineExercise() calls',
    ],
    ['a name', 'const all = {};\nexport const exercise = defineExercise(all);\n', 'object literal'],
    ['another export', 'export const overrides = defineExercise({});\n', 'export const exercise'],
  ])('a file with %s is refused, and says why', (_, source, reason) => {
    const result = editExerciseFile(source, [WRITER]);
    expect(result.kind).toBe('refused');
    expect(result.kind === 'refused' ? result.reason : '').toContain(reason);
  });

  test('a call named in a comment or a string is prose, not the call', () => {
    const source = `// defineExercise({ old })\nconst s = 'defineExercise({})';\n${SCAFFOLD}`;
    expect(edited(source, [WRITER])).toContain('  writeArticle: {');
  });
});
