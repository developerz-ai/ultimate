// `requests.statements` read off a recorded `/_x/timeline`: one panel read per request, the SQL
// spans counted, the ledger's verdicts passed through, and a refusal or a stranger answered coded.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { FetchJson } from './mcp-request-statements';
import { requestStatements } from './mcp-request-statements';

const loop = { requestId: 'r2', code: 'X_N_PLUS_ONE_QUERY', fix: 'preload(...)', count: 7 };

const trace = (requestId: string, sql: number) => ({
  requestId,
  method: 'GET',
  path: `/${requestId}`,
  status: 200,
  startedAt: '2026-11-13T00:00:00Z',
  spans: [
    { kind: 'http', detail: 'GET' },
    ...Array.from({ length: sql }, () => ({ kind: 'sql', detail: 'select 1' })),
  ],
});

/** A dev server holding three requests, newest first; `asked` records every URL read. */
function devServer(): { get: FetchJson; asked: string[] } {
  const traces = [trace('r3', 1), trace('r2', 7), trace('r1', 0)];
  const asked: string[] = [];
  const get: FetchJson = async (url) => {
    asked.push(url);
    const wanted = new URL(url).searchParams.get('requestId');
    const selected = wanted === null ? traces[0] : traces.find((t) => t.requestId === wanted);
    return {
      panel: 'timeline',
      ok: true,
      data: {
        requests: traces.map((t) => ({ requestId: t.requestId, path: t.path, totalMs: 1 })),
        selected: selected ?? null,
        flame: [],
        totalsByKind: {},
        repeatedSql: selected?.requestId === 'r2' ? [{ sql: 'select 1', count: 7 }] : [],
        nPlusOne: selected?.requestId === 'r2' ? [loop] : [],
      },
    };
  };
  return { get, asked };
}

type Answer = { requests: { requestId: string; statements: number; nPlusOne: unknown }[] };

describe('requestStatements', () => {
  test('the newest requests, each with its own statement count and verdicts', async () => {
    const { get, asked } = devServer();
    const answer = (await requestStatements(
      { devUrl: 'http://localhost:3000', requestId: undefined, limit: 2 },
      get,
    )) as Answer;
    expect(answer.requests.map((r) => [r.requestId, r.statements])).toEqual([
      ['r3', 1],
      ['r2', 7],
    ]);
    expect(answer.requests[1]?.nPlusOne).toEqual([loop]);
    expect(asked).toEqual([
      'http://localhost:3000/_x/timeline?json=1',
      'http://localhost:3000/_x/timeline?json=1&requestId=r2',
    ]);
  });

  test('one request by id; an id the recorder dropped answers the ids it holds', async () => {
    const { get } = devServer();
    const one = (await requestStatements(
      { devUrl: 'http://d', requestId: 'r1', limit: 10 },
      get,
    )) as Answer;
    expect(one.requests.map((r) => r.requestId)).toEqual(['r1']);
    const gone = await requestStatements({ devUrl: 'http://d', requestId: 'r0', limit: 10 }, get);
    expect(gone).toEqual({ devUrl: 'http://d', requests: [], known: ['r3', 'r2', 'r1'] });
  });

  test("the panel's own refusal passes through with its code and fix", async () => {
    const refused: FetchJson = async () => ({
      panel: 'timeline',
      ok: false,
      error: { code: 'X_DEV_SOURCE_UNAVAILABLE', cause: 'no recorder', fix: 'x dev' },
    });
    const error = await requestStatements(
      { devUrl: 'http://d', requestId: undefined, limit: 1 },
      refused,
    ).catch((e: unknown) => e);
    if (!isUltimateError(error)) expect.unreachable('expected an UltimateError');
    expect([error.code, error.fix]).toEqual(['X_DEV_SOURCE_UNAVAILABLE', 'x dev']);
  });

  test('an answer that is no panel is coded, with a restart to run', async () => {
    const stranger: FetchJson = async () => '<html>';
    const error = await requestStatements(
      { devUrl: 'http://d', requestId: undefined, limit: 1 },
      stranger,
    ).catch((e: unknown) => e);
    if (!isUltimateError(error)) expect.unreachable('expected an UltimateError');
    expect(error.code).toBe('X_CLI_UNEXPECTED');
    expect(error.fix).toStartWith('x stop --json && x dev');
  });
});
