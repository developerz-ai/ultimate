// The one per-request head tag that tells the page who it was rendered for — by opaque id only.

import { describe, expect, test } from 'bun:test';
import { clientPersistTags, clientScopeTag, documentCarriesScope } from './client-scope-tag';
import { renderHead } from './head';

describe('clientScopeTag', () => {
  test('renders the one meta core reads, with the opaque scope as its content', () => {
    expect(renderHead([clientScopeTag('0123abcd')])).toBe(
      '<meta name="ultimate-scope" content="0123abcd">',
    );
  });

  test('the anonymous page carries the meta with an EMPTY content, never no meta', () => {
    // Absent and empty are different answers: empty is "nobody", absent is "not rendered per
    // request" (a shared static document), which must not rescope anyone.
    expect(renderHead([clientScopeTag('')])).toBe('<meta name="ultimate-scope" content="">');
  });
});

describe('clientPersistTags', () => {
  test('the persisted record types, sorted, as one meta', () => {
    expect(renderHead(clientPersistTags(['post', 'comment']))).toBe(
      '<meta name="ultimate-persist" content="comment,post">',
    );
  });

  test('nothing persisted is no tag at all', () => {
    expect(clientPersistTags([])).toEqual([]);
  });
});

describe('documentCarriesScope', () => {
  test('only a private document may carry a principal', () => {
    expect(documentCarriesScope({ 'cache-control': 'private, no-store' })).toBe(true);
    expect(
      documentCarriesScope({
        'cache-control': 'public, max-age=0, s-maxage=30, stale-while-revalidate=300',
      }),
    ).toBe(false);
    expect(documentCarriesScope({ 'cache-control': 'public, max-age=0, must-revalidate' })).toBe(
      false,
    );
    expect(documentCarriesScope({})).toBe(false);
  });
});
