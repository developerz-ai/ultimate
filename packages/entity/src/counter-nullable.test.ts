// A `countedIn` target that is nullable is refused: Postgres' `NULL + 1` stays NULL while the memory
// driver counts from 0, so the two drivers would disagree from the first child. Its own file — once
// registered, the refused key refuses every reading of the counters, as it should.

import { afterAll, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { integer, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

test('a nullable counting column is refused at describe, naming the column', () => {
  const posts = entity('cntn_posts', {
    columns: { id: uuid().primaryKey(), likeCount: integer().nullable() },
  });
  entity('cntn_likes', {
    columns: {
      id: uuid().primaryKey(),
      postId: uuid().references(() => posts.id, { countedIn: () => posts.likeCount }),
    },
  });
  const refusal = (() => {
    try {
      posts.$describe();
    } catch (error) {
      return isUltimateError(error) ? { code: error.code, cause: error.cause } : 'uncoded';
    }
    return 'accepted';
  })();
  expect(refusal).toEqual({
    code: 'X_ENTITY_COUNTS_INVALID',
    cause: expect.stringContaining('cntn_posts.likeCount is nullable'),
  });
});
