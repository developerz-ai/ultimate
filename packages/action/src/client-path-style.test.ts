// Which URL the typed client posts to when the app states no `pathStyle`: the one the SERVER
// stamped into the document. The stamp is `@ultimat3/core`'s `CLIENT_PATH_STYLE_META`; a browser
// has it, a script does not, and a caller naming a style is naming a server other than the page's.

import { afterEach, describe, expect, test } from 'bun:test';
import { CLIENT_PATH_STYLE_META } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { type FetchLike, rpc } from './client';

const signIn = action({
  input: t.object({ email: t.email }),
  output: t.object({ ok: t.boolean }),
  policy: allow(),
  handle: () => ({ ok: true }),
});

const webhook = action({
  input: t.object({ id: t.string }),
  output: t.object({ ok: t.boolean }),
  policy: allow(),
  http: { path: '/hooks/vendor' },
  handle: () => ({ ok: true }),
});

type Actions = { readonly signIn: typeof signIn };

/** The document a server rendering under `style` hands the browser; `undefined` writes no stamp. */
const stamp = (style: string | undefined): void => {
  Reflect.set(globalThis, 'document', {
    querySelector: (selector: string) =>
      selector === `meta[name="${CLIENT_PATH_STYLE_META}"]` && style !== undefined
        ? { content: style }
        : null,
  });
};

/** The URL one `signIn` call was dispatched to. */
async function urlOf(call: (fetchStub: FetchLike) => Promise<unknown>): Promise<string> {
  const seen: string[] = [];
  await call(async (url) => {
    seen.push(url);
    return Response.json({ ok: true });
  });
  expect(seen).toHaveLength(1);
  return seen[0] ?? '';
}

const INPUT = { email: 'a@b.test' };

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

describe('the path style a browser client derives under', () => {
  test("is the document's stamp when the app states none", async () => {
    stamp('readable');
    const url = await urlOf((fetch) => rpc<Actions>({ baseUrl: '', fetch }).signIn(INPUT));
    expect(url).toBe('/api/sign-in');
  });

  test("is 'resource' under a document with no stamp — what that server serves", async () => {
    stamp(undefined);
    const url = await urlOf((fetch) => rpc<Actions>({ baseUrl: '', fetch }).signIn(INPUT));
    expect(url).toBe('/api/ins/sign');
  });

  test('is read when the method is taken, so a client built at module scope still follows it', async () => {
    let fetchStub: FetchLike = async () => Response.json({ ok: true });
    const client = rpc<Actions>({ baseUrl: '', fetch: (url, init) => fetchStub(url, init) });
    stamp('readable');
    const url = await urlOf((fetch) => {
      fetchStub = fetch;
      return client.signIn(INPUT);
    });
    expect(url).toBe('/api/sign-in');
  });

  test("a stated `pathStyle` wins over the stamp: it names another server's style", async () => {
    stamp('readable');
    const url = await urlOf((fetch) =>
      rpc<Actions>({ baseUrl: 'https://other.test', fetch, pathStyle: 'resource' }).signIn(INPUT),
    );
    expect(url).toBe('https://other.test/api/ins/sign');
  });

  test('`action.client()` follows the same stamp — one derivation, two spellings', async () => {
    stamp('readable');
    const url = await urlOf((fetch) =>
      signIn.named('signIn').client({ baseUrl: '', fetch })(INPUT),
    );
    expect(url).toBe('/api/sign-in');
  });

  test('a pinned `http.path` is the URL under every stamp', async () => {
    stamp('readable');
    const url = await urlOf((fetch) =>
      webhook.named('webhook').client({ baseUrl: '', fetch })({ id: 'x' }),
    );
    expect(url).toBe('/hooks/vendor');
  });
});

describe('a caller with no document — a script, another service', () => {
  test("derives under 'resource' unless it states the style", async () => {
    expect(Reflect.has(globalThis, 'document')).toBe(false);
    const plain = await urlOf((fetch) =>
      rpc<Actions>({ baseUrl: 'https://app.test', fetch }).signIn(INPUT),
    );
    const stated = await urlOf((fetch) =>
      rpc<Actions>({ baseUrl: 'https://app.test', fetch, pathStyle: 'readable' }).signIn(INPUT),
    );
    expect(plain).toBe('https://app.test/api/ins/sign');
    expect(stated).toBe('https://app.test/api/sign-in');
  });
});
