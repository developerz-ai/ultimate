// The one authz escape on the read path, and the bar it is held to. It was `enforce: false` — a
// bare boolean with no capability, no reason and no audit — while the framework's OTHER authz
// escape (`@ultimat3/entity`'s `crossTenant`) refuses a boolean argument outright, because it
// "reads exactly like forgetting the tenant". The same is true of a forgotten policy.

import { afterEach, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { query } from './query';
import { sourceFor } from './read';
import { resetRegistry } from './registry';
import { from } from './source';

interface Row {
  readonly id: string;
}

const denied = () =>
  query({
    input: t.object({ noop: t.boolean }),
    policy: can('post:read'),
    sql: () => from<Row>('posts', () => [{ id: '1' }]).orderBy('id', 'asc'),
  }).named('guardedRead');

/** No permission at all: every enforced build has to refuse this caller. */
const stranger = createContext({ actor: userActor({ id: 'u9' }) });

afterEach(() => {
  resetRegistry();
});

describe('skipping a read policy costs a written reason', () => {
  test('the default build enforces — nothing is skipped by omission', async () => {
    await expect(sourceFor(denied(), { noop: true }, { ctx: stranger })).rejects.toThrow(
      /X_FORBIDDEN|X_UNAUTHENTICATED/,
    );
  });

  test('a stated reason is what opens it, and the source is built', async () => {
    const source = await sourceFor(
      denied(),
      { noop: true },
      { ctx: stranger, unenforced: 'a test asserting the SQL text reads no rows' },
    );
    expect(source.toSQL().sql).toContain('posts');
  });

  test('a BLANK reason is refused — an escape with no argument is a pragma', async () => {
    await expect(
      sourceFor(denied(), { noop: true }, { ctx: stranger, unenforced: '   ' }),
    ).rejects.toThrow(/blank unenforced reason/);
  });

  test('the refusal happens before the source exists, so nothing is read on a blank one', async () => {
    let built = 0;
    const counted = query({
      input: t.object({ noop: t.boolean }),
      policy: can('post:read'),
      sql: () => {
        built += 1;
        return from<Row>('posts', () => [{ id: '1' }]).orderBy('id', 'asc');
      },
    }).named('countedRead');

    await expect(
      sourceFor(counted, { noop: true }, { ctx: stranger, unenforced: '' }),
    ).rejects.toThrow(/blank unenforced reason/);
    expect(built).toBe(0);
  });
});
