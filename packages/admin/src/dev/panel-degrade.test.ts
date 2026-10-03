// A panel degrades for ONE reason — the source is not wired (`DevSourceUnavailableError`) — and
// for no other. A source that is wired and FAILS is a diagnostic, and reaches `panelPayload` with
// its code and its fix instead of reading as "no detector" or "no invalidations yet".

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { staticDevSources } from './data';
import type { RequestTrace } from './facts';
import { cachePanel } from './panel-cache';
import { timelinePanel } from './panel-timeline';

// A foreign failure handed to the code under test is input, not a verdict.
const broken = (): Promise<never> =>
  Promise.reject(
    new UltimateError({
      code: 'X_DB_STATEMENT_FAILED',
      cause: 'the ledger is down',
      fix: 'x doctor',
    }),
  );

const traces = async (): Promise<readonly RequestTrace[]> => [];

describe('unit · a wired source that fails is not an unwired one', () => {
  test('timeline: a failing detector rejects the panel — it is not "no detector"', async () => {
    const sources = staticDevSources({ traces, statementLoops: broken });
    await expect(timelinePanel.data(sources, new URLSearchParams())).rejects.toBeUltimateError(
      'X_DB_STATEMENT_FAILED',
    );
  });

  test('cache: a failing invalidation log rejects the panel — it is not "none yet"', async () => {
    const sources = staticDevSources({ invalidations: broken });
    await expect(cachePanel.data(sources, new URLSearchParams())).rejects.toBeUltimateError(
      'X_DB_STATEMENT_FAILED',
    );
  });
});
