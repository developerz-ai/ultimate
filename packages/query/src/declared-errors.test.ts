// `errors:` on a query, the dynamic half — the action's fixture, read side: judged around `sql`
// and `execute` only. An undeclared 4xx is red in a test run and the original in production; a
// policy denial and `X_INPUT_INVALID` are never judged; a declared code passes.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  collectMetrics,
  ctxOf,
  defineError,
  isUltimateError,
  resetMetrics,
  userActor,
} from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryOpenApiOperation } from './openapi';
import { query } from './query';
import { registerQueries, resetQueries } from './registry';
import { from } from './source';

const Gone = defineError({
  code: 'X_DECLARED_FEED_GONE',
  title: 'query declared-errors fixture: the feed is gone',
  status: 410,
  cause: 'a fixture',
  fix: 'nothing: a fixture',
});
const Hidden = defineError({
  code: 'X_DECLARED_FEED_HIDDEN',
  title: 'query declared-errors fixture: the feed is hidden',
  status: 404,
  cause: 'a fixture',
  fix: 'nothing: a fixture',
});

const reader = (permissions: readonly string[]) =>
  ctxOf({ actor: { ...userActor({ id: 'u1' }), permissions } });
const ctx = reader(['feed:read']);

const feed = (
  errors: readonly string[] = ['X_DECLARED_FEED_GONE'],
  from_: 'sql' | 'execute' = 'sql',
) => {
  const orgFeed = query({
    input: t.object({ mode: t.string }),
    policy: can('feed:read'),
    errors,
    sql: ({ mode }) => {
      if (from_ === 'sql' && mode === 'gone') throw new Gone();
      if (from_ === 'sql' && mode === 'hidden') throw new Hidden();
      const source = from<{ id: string }>('feeds', [{ id: 'a' }]);
      if (from_ === 'execute') {
        Object.defineProperty(source, 'execute', { value: () => Promise.reject(new Hidden()) });
      }
      return source;
    },
  });
  registerQueries({ orgFeed });
  return orgFeed;
};

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the read answered');
}

afterEach(() => {
  resetQueries();
  resetMetrics();
});

describe('a query declaring errors:', () => {
  test('a declared refusal passes; an undeclared one out of sql is X_ERROR_UNDECLARED', async () => {
    const target = feed();
    expect(Gone.is(await rejection(() => target({ mode: 'gone' }, { ctx })))).toBe(true);
    const error = await rejection(() => target({ mode: 'hidden' }, { ctx }));
    if (!isUltimateError(error)) return expect.unreachable('a coded refusal');
    expect(error.code).toBe('X_ERROR_UNDECLARED');
    expect(error.fix).toContain("'X_DECLARED_FEED_HIDDEN' ]   # add it in the orgFeed definition");
    expect(Hidden.is(error.sourceError)).toBe(true);
  });

  test('a throw out of the source’s execute is judged the same', async () => {
    const target = feed(['X_DECLARED_FEED_GONE'], 'execute');
    const error = await rejection(() => target({ mode: 'any' }, { ctx }));
    expect(isUltimateError(error) && error.code).toBe('X_ERROR_UNDECLARED');
  });

  test('production answers the original and counts it', async () => {
    const target = feed();
    const saved = process.env['ULTIMATE_ENV'];
    process.env['ULTIMATE_ENV'] = 'production';
    try {
      expect(Hidden.is(await rejection(() => target({ mode: 'hidden' }, { ctx })))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['ULTIMATE_ENV'];
      else process.env['ULTIMATE_ENV'] = saved;
    }
    const metric = collectMetrics().metrics.find(
      (entry) => entry.descriptor.name === 'undeclared_errors_total',
    );
    expect(metric?.points[0]?.attributes).toEqual({
      primitive: 'query',
      name: 'orgFeed',
      code: 'X_DECLARED_FEED_HIDDEN',
    });
  });

  test('a policy denial and X_INPUT_INVALID are never judged, even under errors: []', async () => {
    const target = feed([]);
    const denied = await rejection(() => target({ mode: 'any' }, { ctx: reader([]) }));
    expect(isUltimateError(denied) && denied.code).not.toBe('X_ERROR_UNDECLARED');
    const invalid = await rejection(() => target({ mode: 7 } as never, { ctx }));
    expect(isUltimateError(invalid) && invalid.code).toBe('X_INPUT_INVALID');
  });

  test('the list is checked and sorted, described, and in the OpenAPI operation', () => {
    const target = feed(['X_DECLARED_FEED_HIDDEN', 'X_DECLARED_FEED_GONE']);
    expect(target.errors).toEqual(['X_DECLARED_FEED_GONE', 'X_DECLARED_FEED_HIDDEN']);
    expect(target.describe().errors).toEqual(['X_DECLARED_FEED_GONE', 'X_DECLARED_FEED_HIDDEN']);
    const responses = toQueryOpenApiOperation(target)['responses'] as Record<string, unknown>;
    expect(Object.keys(responses).sort()).toEqual(['200', '400', '403', '404', '410']);
    expect(() => feed(['X_NEVER_DECLARED_ANYWHERE'])).toThrow(
      expect.objectContaining({ code: 'X_ACTION_ERRORS_INVALID' }),
    );
  });
});

describe('the declared-errors contract assertion', () => {
  const scanOf = (target: {
    contract(): readonly { readonly name: string; run(): Promise<void> }[];
  }) =>
    target
      .contract()
      .find((contract) => contract.name.endsWith('names only the errors it declares'));

  test('a stray class in sql fails it naming the code; the list holding it passes', async () => {
    await expect(scanOf(feed())?.run()).rejects.toMatchObject({
      code: 'X_ERROR_UNDECLARED',
      fix: expect.stringContaining(
        "'X_DECLARED_FEED_HIDDEN' ]   # add it in the orgFeed definition",
      ),
    });
    resetQueries();
    await scanOf(feed(['X_DECLARED_FEED_GONE', 'X_DECLARED_FEED_HIDDEN']))?.run();
  });

  test('a read declaring nothing gets no extra assertion', () => {
    const open = query({
      input: t.object({}),
      policy: can('feed:read'),
      sql: () => from<{ id: string }>('feeds', []),
    });
    registerQueries({ openFeed: open });
    expect(scanOf(open)).toBeUndefined();
  });
});
