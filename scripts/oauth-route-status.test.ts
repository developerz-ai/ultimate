// The pin under the one duplicated table in the framework: `@ultimat3/http`'s `error-map.ts` owns
// every code → status, and `@ultimat3/auth`'s OAuth descriptors answer outside a pipeline, so they
// carry a copy. Both are tier 2 and can never import each other; this file can import both, which
// is the same trick `packages/cli`'s `mcp-exposure-pin.test.ts` uses for a question no single
// package can ask.

import { describe, expect, test } from 'bun:test';
import { OAUTH_ROUTE_STATUS } from '@ultimat3/auth';
import { statusFor } from '@ultimat3/http';

describe('the OAuth descriptors and the HTTP status table', () => {
  test('answer the same status for every code the descriptors name', () => {
    const disagreements = Object.entries(OAUTH_ROUTE_STATUS).filter(
      ([code, status]) => statusFor(code) !== status,
    );

    // A row that drifts is a route answering 403 standalone and 500 once an app mounts it behind
    // the pipeline — the same request, two answers, and only one of them pages the on-call.
    expect(disagreements).toEqual([]);
  });

  test('the default is the same on both sides, so an unlisted code cannot mean two things', () => {
    // `problem()` falls to 502 for an uncoded throw out of the provider conversation, and every
    // code it does not list is `statusFor`'s 500. The two defaults answer different questions;
    // what may not differ is a code that IS listed.
    expect(OAUTH_ROUTE_STATUS['X_OAUTH_EXCHANGE_FAILED']).toBeUndefined();
    expect(statusFor('X_OAUTH_EXCHANGE_FAILED')).toBe(502);
  });
});
