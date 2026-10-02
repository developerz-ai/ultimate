// The one channel a page has to the browser is an island's props bag, inlined into the HTML of
// every response. `@ultimat3/entity` answers a sealed column as a SERVER-ONLY property — own,
// readable by name, not enumerable — and this is render's half of that contract: the bag is built
// from what a value ENUMERATES, so a repository row passed whole to an island carries no secret.
//
// The row is built here rather than through an entity: this package does not depend on
// `@ultimat3/entity`, and `packages/entity/src/sealed.test.ts` pins that its rows have this shape.

import { describe, expect, test } from 'bun:test';
import { emitIslandProps } from './hydrate';
import { checkIslandProps } from './island-props';

const CANARY = 'PLAINTEXT-CANARY-7f3a';

/** A repository row of an entity with a sealed `credential`, as `serverOnly()` shapes it. */
const row = (): { readonly id: string; readonly name: string; readonly credential: string } => {
  const out = { id: 'a1', name: 'Ada' } as { id: string; name: string; credential: string };
  Object.defineProperty(out, 'credential', {
    value: CANARY,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return out;
};

describe('unit · a sealed column reaches no island', () => {
  test('the fixture is a row server code can read', () => {
    expect(row().credential).toBe(CANARY);
  });

  test('a row, a list of rows and a nested row cross without it', () => {
    const account = row();
    const bag = checkIslandProps(
      { account, accounts: [account], page: { rows: [account], first: account } },
      ['account', 'accounts', 'page'],
      'apps/web/app/accounts/page.tsx',
      'account-card',
    );
    const bytes = JSON.stringify(bag);
    expect(bytes).toContain('Ada');
    expect(bytes).not.toContain(CANARY);
    expect(bytes).not.toContain('credential');
    expect(bag['account']).toEqual({ id: 'a1', name: 'Ada' });
  });

  test('…and so does the script tag the document carries', () => {
    const props = checkIslandProps({ account: row() }, ['account'], 'page.tsx', 'account-card');
    const html = emitIslandProps({
      islandId: 'i0',
      entry: '/_x/islands/account-card.js',
      strategy: 'idle',
      props,
    });
    expect(html).toContain('Ada');
    expect(html).not.toContain(CANARY);
  });
});
