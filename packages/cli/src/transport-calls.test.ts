// What counts as browser code opening its own connection, in one file's text. Every false positive
// the rule has to leave alone is a fixture here — a noisy rule is a rule its readers switch off.

import { describe, expect, test } from 'bun:test';
import { bindsFetch, transportCalls } from './transport-calls';

const shapes = (source: string): readonly string[] =>
  transportCalls(source).map((call) => `${call.shape}:${call.spelled}`);

describe('what counts as opening a connection', () => {
  test('a fetch CALL, bare or through the global object, is reported', () => {
    expect(shapes('await fetch(url);')).toEqual(['fetch:fetch']);
    expect(shapes('await globalThis.fetch(url);')).toEqual(['fetch:globalThis.fetch']);
    expect(shapes('await window .fetch(url);')).toEqual(['fetch:window.fetch']);
  });

  test('each constructed transport is reported under its own shape', () => {
    expect(
      shapes('new WebSocket(u); new globalThis.XMLHttpRequest(); new EventSource(u);'),
    ).toEqual(['websocket:WebSocket', 'xhr:XMLHttpRequest', 'eventsource:EventSource']);
  });

  test('each call carries the line it sits on, in source order', () => {
    const source = "const a = 1;\nawait fetch('/a');\n\nnew WebSocket('/s');\n";
    expect(transportCalls(source).map((call) => [call.shape, call.line])).toEqual([
      ['fetch', 2],
      ['websocket', 4],
    ]);
  });

  test('an injected default is the seam, never a call', () => {
    expect(
      shapes('function send(fetchImpl = globalThis.fetch) { return fetchImpl(u, i); }'),
    ).toEqual([]);
    expect(shapes('const run = options.fetch ?? browserFetch; run(u, i);')).toEqual([]);
  });

  test('a method named fetch is not the global — called or defined', () => {
    expect(shapes('const res = await server.fetch(new Request(u));')).toEqual([]);
    expect(shapes('Bun.serve({ fetch(req) { return new Response(); } });')).toEqual([]);
    expect(
      shapes('class H { async fetch(req: Request): Promise<Response> { return x; } }'),
    ).toEqual([]);
    expect(shapes('export async function fetch(key: string) { return key; }')).toEqual([]);
  });

  test('a definition is told from a call by what follows ITS closing parenthesis', () => {
    // The arguments hold parentheses, a string and a regex with one of its own: none moves the close.
    expect(shapes("const o = { fetch(a = f(')'), b = /\\)/) { return a; } };")).toEqual([]);
    expect(shapes("await fetch(url(')'), { body: g(1) });")).toEqual(['fetch:fetch']);
    // Unbalanced to the end of the file: not a definition, so still a call.
    expect(shapes('fetch(')).toEqual(['fetch:fetch']);
  });

  test('a local binding named fetch shadows the global — the idempotency-postgres shape', () => {
    const source =
      'const fetch = async (key: string) => rows.get(key);\nconst e = await fetch(key);';
    expect(shapes(source)).toEqual([]);
    expect(shapes('const load = async (fetch: F, key: string) => fetch(key);')).toEqual([]);
    expect(bindsFetch("import { fetch } from './db';")).toBe(true);
    expect(bindsFetch('const { fetch } = deps;')).toBe(true);
    // ...and never through the global object, which no local shadows.
    expect(shapes('const fetch = f;\nglobalThis.fetch(u);')).toEqual(['fetch:globalThis.fetch']);
  });

  test('a name that merely starts with fetch, a string and a comment are not calls', () => {
    expect(shapes('await fetchSignedPut(input);')).toEqual([]);
    expect(shapes("const msg = 'never call fetch( here';")).toEqual([]);
    expect(shapes('// fetch(url) would bypass the store\nconst x = 1;')).toEqual([]);
    expect(shapes('const t = `await fetch(url)`;')).toEqual([]);
  });

  test('a file naming no transport at all is answered without being read further', () => {
    expect(transportCalls('export const add = (a: number, b: number) => a + b;')).toEqual([]);
  });
});
