// Single responsibility: `input: posts.$view(['title'])` through `invoke` — the bound published
// to OpenAPI is the bound refused, and the refusal reaches the caller AT THE FIELD. WHY: `$view` is
// what `posts.$input.pick()` would have been, and a refusal at `path: ''` binds no form control.

import { afterAll, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { invoke } from './invoke';

const posts = entity('view_input_posts', {
  columns: { id: uuid().primaryKey(), title: text({ max: 200 }) },
});

const retitle = action({
  input: posts.$view(['title']),
  output: t.object({ ok: t.boolean }),
  policy: can('post:edit'),
  handle: () => ({ ok: true }),
}).named('retitlePost');

const ctx = ctxOf({ actor: { ...userActor({ id: 'u1' }), permissions: ['post:edit'] } });

afterAll(() => {
  clearRegistry();
});

describe('a $view as an action input', () => {
  test('refuses 300 characters at path "title", with the column’s rule', async () => {
    try {
      await invoke(retitle, { title: 'x'.repeat(300) }, { ctx });
      expect.unreachable('a 300-character title was accepted');
    } catch (error) {
      expect(error).toMatchObject({ code: 'X_INPUT_INVALID' });
      const issues = (error as { meta: { issues: readonly Record<string, unknown>[] } }).meta
        .issues;
      expect(issues[0]).toMatchObject({
        path: 'title',
        rule: 'string.max',
        params: { max: 200 },
        message: 'expected at most 200 characters, got 300',
      });
    }
  });

  test('accepts a title within the bound', async () => {
    expect(await invoke(retitle, { title: 'fine' }, { ctx })).toEqual({ ok: true });
  });
});
