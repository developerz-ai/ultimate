// One question: what a 500 the framework did not classify TELLS the caller, in production, on
// each of the two surfaces. They disagreed. `error-page.ts` shows a browser the status, the code
// and the request id and nothing off the throwable; the problem document rendered `facts.cause`,
// which for an unclassified 500 falls through to the exception's own `message` — a Postgres error
// quoting the row it rejected, a DSN, a file path. One condition, two audiences, one answer.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { text } from './response';
import { createRouter, type Route } from './router';

/** What a driver actually throws: the credential and the rejected row, in one string. */
const LEAK =
  'connect ECONNREFUSED postgres://app:hunter2@db.internal/app — duplicate key value violates ' +
  'unique constraint "users_email_key" DETAIL: Key (email)=(ada@example.test) already exists.';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/boom',
    meta: { name: 'boom', auth: 'public' },
    handler: () => {
      throw new TypeError(LEAK);
    },
  },
  {
    method: 'GET',
    path: '/shed',
    meta: { name: 'shed', auth: 'public' },
    handler: () => {
      // A code the framework OWNS and maps to 503: its cause is a sentence the framework wrote,
      // so redacting it would take away the one instruction the caller can act on.
      throw Object.assign(new Error('draining'), {
        code: 'X_DRAINING',
        cause: 'this process is draining',
      });
    },
  },
  {
    method: 'GET',
    path: '/ok',
    meta: { name: 'ok', auth: 'public' },
    handler: () => text('ok'),
  },
];

const ask = async (path: string, accept: string, dev = false): Promise<Response> =>
  createPipeline({
    table: createRouter(routes),
    config: defineHttpConfig({ rateLimit: { enabled: false, scope: 'process' }, dev }),
    hooks: {},
  }).handle(new Request(`http://localhost${path}`, { headers: { accept } }), { role: 'web' });

describe('an unclassified 500 says the same thing to both audiences', () => {
  test('the problem document carries the code and the fix, never the exception text', async () => {
    const response = await ask('/boom', 'application/json');
    expect(response.status).toBe(500);
    const body = (await response.text()) as string;

    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('ada@example.test');
    expect(body).not.toContain('users_email_key');
    const document = JSON.parse(body) as Record<string, string>;
    // What survives is what an agent acts on: the code, the request id, and a command to run.
    expect(document['code']).toBe('X_INTERNAL');
    expect(document['fix']).toContain('x errors explain X_INTERNAL');
    expect(document['cause']).toBe(document['detail']);
    expect(document['cause']).toContain('request id');
  });

  test('the HTML page for the same request says no more, which it already did', async () => {
    const body = await (await ask('/boom', 'text/html')).text();
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('ada@example.test');
  });

  test('a dev process still hands the developer the whole thing', async () => {
    const body = await (await ask('/boom', 'application/json', true)).text();
    expect(body).toContain('hunter2');
  });

  test('a 5xx the framework OWNS keeps its cause — it is a sentence the framework wrote', async () => {
    const document = (await (await ask('/shed', 'application/json')).json()) as Record<
      string,
      string
    >;
    expect(document['code']).toBe('X_DRAINING');
    expect(document['cause']).toBe('this process is draining');
  });

  test('a 4xx is unchanged: the caller made it, and the caller is told what', async () => {
    const document = (await (await ask('/nope', 'application/json')).json()) as Record<
      string,
      string
    >;
    expect(document['code']).toBe('X_ROUTE_NOT_FOUND');
    expect(document['cause']).toContain('/nope');
  });
});
