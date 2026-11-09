// `overrideRows` (`@ultimat3/query/adapter`): canned rows stand where `sql()` is, AFTER the input
// parse and the policy, on every read surface — never cached past the undo; `undefined` restores.

import { afterEach, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { overrideRows } from './adapter';
import { query, runQuery, sourceFor } from './query';
import { from } from './source';

interface Note {
  readonly id: string;
  readonly orgId: string;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const real: readonly Note[] = [{ id: 'real', orgId: ORG }];
let built = 0;

const notes = query({
  input: t.object({ orgId: t.uuid }),
  policy: can('notes:read'),
  cache: { tags: [] },
  sql: ({ orgId }) => {
    built += 1;
    return from<Note>('notes', real).where({ orgId });
  },
}).named('notesOverride');

const reader = ctxOf({ actor: { ...userActor({ id: 'u1' }), permissions: ['notes:read'] } });
const stranger = ctxOf({ actor: userActor({ id: 'u2' }) });

afterEach(() => {
  overrideRows(notes, undefined);
  built = 0;
});

test('canned rows answer every read, and sql() is never built', async () => {
  overrideRows(notes, [{ id: 'canned', orgId: ORG }]);
  expect(await runQuery(notes, { orgId: ORG }, { ctx: reader })).toEqual([
    { id: 'canned', orgId: ORG },
  ]);
  const source = await sourceFor(notes, { orgId: ORG }, { ctx: reader });
  expect(await source.execute()).toEqual([{ id: 'canned', orgId: ORG }]);
  expect(built).toBe(0);
});

test('a function answers from the parsed input and the caller', async () => {
  overrideRows(notes, ({ input, ctx }) => [
    { id: ctx.actor.kind, orgId: (input as { orgId: string }).orgId },
  ]);
  expect(await runQuery(notes, { orgId: ORG }, { ctx: reader })).toEqual([
    { id: 'user', orgId: ORG },
  ]);
});

test('undefined restores the declared read, and no canned row outlives the undo', async () => {
  overrideRows(notes, [{ id: 'canned', orgId: ORG }]);
  await runQuery(notes, { orgId: ORG }, { ctx: reader });
  overrideRows(notes, undefined);
  expect(await runQuery(notes, { orgId: ORG }, { ctx: reader })).toEqual(real);
});

test('the policy still refuses and the input parse still runs', async () => {
  overrideRows(notes, [{ id: 'canned', orgId: ORG }]);
  const denied = await runQuery(notes, { orgId: ORG }, { ctx: stranger }).catch((e: unknown) => e);
  expect(isUltimateError(denied) && denied.code).toBe('X_FORBIDDEN');
  const invalid = await runQuery(notes, { orgId: 'nope' }, { ctx: reader }).catch(
    (e: unknown) => e,
  );
  expect(isUltimateError(invalid) && invalid.code).toBe('X_INPUT_INVALID');
});

test('a fresh read under canned rows leaves no canned row in the request memo', async () => {
  overrideRows(notes, [{ id: 'canned', orgId: ORG }]);
  await runQuery(notes, { orgId: ORG }, { ctx: reader, fresh: true });
  overrideRows(notes, undefined);
  expect(await runQuery(notes, { orgId: ORG }, { ctx: reader })).toEqual(real);
});
