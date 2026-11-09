// A drifted primitive's record names the field no draw can fill, in the line to paste: the hint
// was `input: (drawn) => ({ ...drawn })`, though the sampler already knew which field it was.

import { afterAll, describe, expect, test } from 'bun:test';
import { action, registerActions, t } from '@ultimat3/action';
import { clearRegistry, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { allow } from '@ultimat3/policy';
import { runExercisePass } from './exercise';
import { driftOverrideLine } from './exercise-drift-hint';
import { loadSampler } from './exercise-input';
import type { SeedWriter } from './seed-graph-plan';
import { testName } from './test-types';

afterAll(() => {
  clearRegistry();
});

const orgs = entity('edh_orgs', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
const driver = memoryDriver();
const writer: SeedWriter = {
  insert: async ({ row }) => {
    await driver.repo(orgs).insert(row as never);
  },
  update: async () => undefined,
  snapshot: async (rows) => rows.map(() => 'unchanged'),
};

// A pattern no string matches: no draw, minimal or seeded, ever fills it.
const NEVER = /^(?=x)y$/;

const edhSign = action({
  input: t.object({ digest: t.string.pattern(NEVER), note: t.string.max(10) }),
  output: t.object({ ok: t.boolean }),
  policy: allow(),
  handle: () => ({ ok: true }),
});
registerActions({ edhSign });

describe(testName('unit', 'x exercise · the drift hint'), () => {
  test("the record's override line binds the field the draw cannot fill", async () => {
    const records = await runExercisePass({
      entities: [orgs],
      writer,
      roles: () => [{ name: 'anonymous', actor: null }],
      only: 'edhSign',
    });
    expect(records[0]).toMatchObject({ outcome: 'unreached', code: 'X_CONTRACT_DRIFT' });
    expect(records[0]?.override).toBe(
      'edhSign: { input: (drawn) => ({ ...drawn, digest: "<must match ^(?=x)y$>" }) },',
    );
  });

  test('an id field rides beside the gap; with neither, the refinement placeholder stays', async () => {
    const sampler = await loadSampler();
    const schema = t.object({ code: t.string.pattern(NEVER), postId: t.uuid });
    expect(driftOverrideLine('a', schema, sampler, ['postId'])).toBe(
      'a: { input: (drawn) => ({ ...drawn, code: "<must match ^(?=x)y$>", postId: "<a real id>" }) },',
    );
    // A field the pass bound to a seeded row is bound to that row, not to a placeholder.
    const id = '0b6f4c1e-7d2a-4c55-9a51-3f0c8e2b9d10';
    expect(driftOverrideLine('a', schema, sampler, ['postId'], { postId: id })).toBe(
      `a: { input: (drawn) => ({ ...drawn, code: "<must match ^(?=x)y$>", postId: "${id}" }) },`,
    );
    expect(driftOverrideLine('b', t.object({ n: t.string }), sampler, [])).toBe(
      "b: { input: (drawn) => ({ ...drawn, field: '<a value the refinement accepts>' }) },",
    );
  });
});
