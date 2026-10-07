// The request headers every tier names, pinned by value: a client from one build and a server from
// the next must agree on the spelling, so a rename here is a breaking wire change, never a refactor.

import { describe, expect, test } from 'bun:test';
import { BUILD_ID_HEADER, CLIENT_BUILD_META, IDEMPOTENCY_HEADER } from './index';

describe('the wire headers core owns', () => {
  test('the build id: the header and the document meta are ONE spelling', () => {
    expect(BUILD_ID_HEADER).toBe('x-ultimate-build');
    expect(BUILD_ID_HEADER).toBe(CLIENT_BUILD_META);
  });

  test('the idempotency key, RFC 9110 lower-cased', () => {
    expect(IDEMPOTENCY_HEADER).toBe('idempotency-key');
  });
});
