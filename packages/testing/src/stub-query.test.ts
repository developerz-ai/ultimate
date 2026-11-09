// A stubbed query answers its rows from the script on the REAL read path: the policy still refuses,
// the input is still parsed (the stub records the parsed value), the SQL is never built, and the
// next test reads through the declaration again.

import { describe, expect } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { allow, deny } from '@ultimat3/policy';
import { from, query } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { stub } from './stub';
import { unitTest } from './test-types';

interface Note {
  readonly id: string;
  readonly title: string;
}

const built: string[] = [];
const ada = userActor({ id: 'ada', orgId: 'org-1' });

const notes = query({
  input: t.object({ q: t.string }),
  policy: allow(),
  sql: (input) => {
    built.push(input.q);
    return from<Note>('stub_query_notes', [{ id: 'real', title: 'from sql' }]);
  },
}).named('stubQueryNotes');

const secret = query({
  input: t.object({ q: t.string }),
  policy: deny('stubbed primitives still answer to their policy'),
  sql: () => from<Note>('stub_query_secret', []),
}).named('stubQuerySecret');

describe('stub(query)', () => {
  unitTest('the rows are the script; the SQL is never built; the call is recorded', async () => {
    const stubbed = await stub(notes);
    stubbed.returns([{ id: 'n1', title: 'stubbed' }]);
    expect(await notes.as(ada, { q: 'hello' })).toEqual([{ id: 'n1', title: 'stubbed' }]);
    expect(built).toEqual([]);
    expect(stubbed).toHaveBeenCalledWith({ q: 'hello' });
    expect(stubbed.calls[0]?.actor.id).toBe('ada');
  });

  unitTest('the next test reads through the declaration again', async () => {
    expect(await notes.as(ada, { q: 'again' })).toEqual([{ id: 'real', title: 'from sql' }]);
    expect(built).toEqual(['again']);
  });

  unitTest('the policy still refuses before the stub is reached', async () => {
    const stubbed = await stub(secret);
    stubbed.returns([]);
    await expect(secret.as(ada, { q: 'x' })).rejects.toBeUltimateError();
    expect(stubbed.calls).toHaveLength(0);
  });

  unitTest('an input the parse refuses never reaches the stub', async () => {
    const stubbed = await stub(notes);
    stubbed.returns([]);
    await expect(notes.as(ada, { q: 1 } as never)).rejects.toBeUltimateError();
    expect(stubbed.calls).toHaveLength(0);
  });
});
