// Failure capture at `runQuery`: a read that fails 5xx keeps its parsed input and the reader; one
// that fails under 500 keeps nothing.

import { afterEach, expect, test } from 'bun:test';
import type { FailureBundle } from '@ultimat3/core';
import {
  ctxOf,
  reportError,
  settleFailureCaptures,
  UltimateError,
  userActor,
} from '@ultimat3/core';
import { installFailureStore } from '@ultimat3/core/adapter';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { query } from './query';
import { runQuery } from './read';
import { from } from './source';

const failingWith = (code: string) =>
  query({
    input: t.object({ orgId: t.string }),
    policy: allow(),
    sql: () =>
      from<{ id: string }>('rows', async () => {
        throw new UltimateError({ code, cause: 'planted', fix: 'x verify' });
      }),
  }).named(`feed${code}`);

const saved: FailureBundle[] = [];
let releaseStore: () => void = () => undefined;
afterEach(() => {
  releaseStore();
  saved.length = 0;
});

const read = async (code: string): Promise<void> => {
  releaseStore();
  releaseStore = installFailureStore({ save: async (bundle) => void saved.push(bundle) });
  try {
    await runQuery(
      failingWith(code),
      { orgId: 'o1' },
      { ctx: ctxOf({ actor: userActor({ id: 'r1' }) }) },
    );
  } catch (error) {
    reportError(error, { source: 'http' });
  }
  await settleFailureCaptures();
};

test('a read failing 5xx keeps its input and its reader', async () => {
  await read('X_PLANTED_FAILURE');
  expect(saved.map((bundle) => [bundle.primitive, bundle.input, bundle.actor?.id])).toEqual([
    ['query', { orgId: 'o1' }, 'r1'],
  ]);
});

test('a read failing under 500 keeps nothing', async () => {
  await read('X_NOT_FOUND');
  expect(saved).toEqual([]);
});
