// A `countedIn` `where` over a sealed column is refused: the stored string is ciphertext, so the
// trigger would compare it with the plaintext literal and memory would judge the sealed row — the
// counter would silently never count.

import { afterAll, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { integer, text, uuid } from './columns';
import { whereColumns } from './counter';
import { entity } from './entity';
import type { Expr } from './expr';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const posts = entity('cnts_posts', {
  columns: { id: uuid().primaryKey(), upCount: integer().default(0) },
});
const votes = entity('cnts_votes', {
  columns: {
    id: uuid().primaryKey(),
    postId: uuid().references(() => posts.id, {
      countedIn: {
        to: () => posts.upCount,
        where: (): Expr => whereColumns(votes).secret.eq('up'),
      },
    }),
    secret: text().sealed(),
  },
});

test('a predicate over a sealed column is refused, naming the column', () => {
  try {
    votes.$describe();
  } catch (error) {
    expect(isUltimateError(error) ? error.code : 'uncoded').toBe('X_ENTITY_COUNTS_INVALID');
    expect(isUltimateError(error) ? error.cause : '').toContain('secret is sealed');
    return;
  }
  expect.unreachable('a sealed predicate was accepted');
});
