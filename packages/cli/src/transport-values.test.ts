// The global `fetch` passed on as a value: every spelling an island hands its client module, and
// every look-alike the rule must leave alone — a property, a shadowing binding, a type.

import { describe, expect, test } from 'bun:test';
import { fetchValues } from './transport-values';

const spelled = (source: string): readonly string[] =>
  fetchValues(source).map((value) => `${value.line}:${value.spelled}`);

describe('the global fetch handed on as a value', () => {
  test.each([
    ['shorthand into a client', 'const c = createClient({ baseUrl, fetch });'],
    ['an explicit key', 'const c = createClient({ fetch: fetch });'],
    ['an alias', 'const f = fetch;'],
    ['an argument', 'someFn(fetch);'],
    ['a second argument', 'someFn(url, fetch)'],
    ['a ternary branch', 'const f = mock ? fetch : stub;'],
    ['a bound copy', 'const f = fetch.bind(window);'],
    ['a JSX prop value', '<Feed fetch={fetch} />'],
  ])('%s', (_name, source) => {
    expect(spelled(source)).toEqual(['1:fetch']);
  });

  test('through the global object, with the spelling quoted', () => {
    expect(spelled('make(globalThis.fetch);\nconst f = window . fetch;\nuse(self.fetch)')).toEqual([
      '1:globalThis.fetch',
      '2:window.fetch',
      '3:self.fetch',
    ]);
  });
});

describe('what is not the global passed on', () => {
  test.each([
    ['a call — transportCalls reports it', "await fetch('/x'); globalThis.fetch(u); fetch?.(u);"],
    ['a property on another object', 'const f = options.fetch; use(client?.fetch);'],
    ['a key naming somebody else', 'rpc({ fetch: browserFetch, fetchUser });'],
    ['an optional interface member', 'interface D { readonly fetch?: Fn; fetch: Fn }'],
    ['a type position', 'type F = typeof fetch; let g: typeof globalThis.fetch;'],
    ['an assignment target', 'window.fetch = wrapped;'],
    ['a string or a comment', "const s = 'fetch';\n// pass fetch here\n"],
    ['a longer name', 'use(prefetch, fetchUser, fetch_x, $fetch);'],
  ])('%s', (_name, source) => {
    expect(spelled(source)).toEqual([]);
  });

  test.each([
    ['an import', "import { fetch } from 'undici';\nmake({ fetch });"],
    ['a parameter', 'export const make = (fetch: Fn) => rpc({ fetch });'],
    [
      'a destructured parameter',
      'export function make({ fetch }: Deps) { return rpc({ fetch }); }',
    ],
    ['a local const', 'const fetch = wrap();\nuse(fetch);'],
  ])('a bare name the file binds itself: %s', (_name, source) => {
    expect(spelled(source)).toEqual([]);
  });

  test('a shadowing file still reports the qualified global', () => {
    expect(spelled('const fetch = wrap();\nuse(globalThis.fetch);')).toEqual([
      '2:globalThis.fetch',
    ]);
  });

  test('`createClient({ fetch })` itself is not mistaken for a destructured parameter', () => {
    expect(spelled('createClient({ fetch }).then(go);')).toEqual(['1:fetch']);
  });
});
