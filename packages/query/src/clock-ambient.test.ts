// One clock: a read called with no context gets one whose `now()` is the installed clock
// (`installClock`), so a `sql()` reading "now" for a window follows `runtime.ts`'s clock.

import { expect, test } from 'bun:test';
import { frozenClock, userActor } from '@ultimat3/core';
import { installClock } from '@ultimat3/core/adapter';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { query, runQuery } from './query';
import { from } from './source';

const stamped = query({
  input: t.object({}),
  policy: allow('clock:read'),
  sql: (_input, ctx) => from('clock_probe', [{ id: 'now', at: ctx.now().toISOString() }]),
}).named('clockProbe');

test('a read with no context reads the installed clock', async () => {
  const release = installClock(frozenClock('2001-02-03T04:05:06Z'));
  try {
    const rows = await runQuery(stamped, {}, { actor: userActor({ id: 'u1' }) });
    expect(rows).toEqual([{ id: 'now', at: '2001-02-03T04:05:06.000Z' }]);
  } finally {
    release();
  }
});
