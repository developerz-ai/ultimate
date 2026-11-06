// An evaluation inside a captured call lands in the failure bundle with the answer it gave, so a
// replay takes the branch the failing request took.

import { afterEach, expect, test } from 'bun:test';
import type { FailureBundle } from '@ultimat3/core';
import {
  anonymousActor,
  reportError,
  setFailureStore,
  settleFailureCaptures,
  UltimateError,
  withFailureCapture,
} from '@ultimat3/core';
import { isEnabled } from './evaluate';
import { defineFlag, resetFlags } from './registry';

afterEach(() => {
  setFailureStore(null);
  resetFlags();
});

test('the flags a failing call evaluated are in its bundle, with their answers', async () => {
  defineFlag({
    kind: 'permanent',
    key: 'feed.ranked',
    description: 'ranked feed',
    targeting: { default: true },
  });
  const saved: FailureBundle[] = [];
  setFailureStore({ save: async (bundle) => void saved.push(bundle) });
  try {
    await withFailureCapture(
      'query',
      'feed',
      () => 500,
      async () => {
        isEnabled('feed.ranked', anonymousActor());
        throw new UltimateError({ code: 'X_BOOM', cause: 'planted', fix: 'x verify' });
      },
    );
  } catch (error) {
    reportError(error, { source: 'http' });
  }
  await settleFailureCaptures();
  expect(saved[0]?.flags).toEqual({ 'feed.ranked': true });
});
