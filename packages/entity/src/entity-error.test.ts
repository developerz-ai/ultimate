// A `$view` key naming no column: applied verbatim, the fix must leave every valid key in place —
// `$view(['id'])` for `['id','title','price','createdAt']` dropped three good columns.

import { describe, expect, test } from 'bun:test';
import { viewKeyUnknown } from './entity-error';

const COLUMNS = ['id', 'title', 'price'] as const;

describe('unit · viewKeyUnknown', () => {
  test('with the key list, the fix is that list minus the bad key', () => {
    const { fix } = viewKeyUnknown('posts', 'createdAt', COLUMNS, [
      'id',
      'title',
      'price',
      'createdAt',
    ]);
    expect(fix).toStartWith('$view(["id", "title", "price"])');
    expect(fix).toContain('# edit the call on posts');
    expect(fix).toContain('pick from: id, title, price');
  });

  test('without the key list, the fix deletes the one key and never shrinks to the first column', () => {
    const { fix } = viewKeyUnknown('posts', 'createdAt', COLUMNS);
    expect(fix).not.toStartWith("$view(['id'])");
    expect(fix).toContain('delete "createdAt"');
    expect(fix).toContain('keep every other key');
    expect(fix).toContain('# edit the call on posts');
  });
});
