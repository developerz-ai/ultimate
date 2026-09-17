// Defect C: a live island's `mount()` dialing a socket (`LiveClient.connect()`, an SSE-based
// live query, anything on `@ultimat3/realtime`) fails EVERY state of EVERY such island, because
// the seal in `island-harness-script.ts` gives `WebSocket`/`EventSource` no inert path — only a
// throw that also records the attempt as an "unstubbed request". Worse: the error's own `fix:`
// then tells the author to add a stub whose `match` the harness's grammar can never accept, so the
// hint printed is not a thing a user can actually do. Both halves are proven here, against the
// REAL script text executed in a sandboxed page-like global — never against a string that merely
// *contains* `window.WebSocket=`, which is what let both defects ship unnoticed.

import { describe, expect, test } from 'bun:test';
import { isStubMatch } from '@ultimat3/testing';
import { HARNESS_GLOBAL, harnessScript, readinessProbe } from './island-harness-script';
import { IslandRequestUnstubbedError } from './island-shot-errors';

/**
 * A minimal page-like sandbox: just enough `window` / `document` / `navigator` for the harness
 * script to install its seal and its clock without throwing on an unrelated missing global. Never
 * a real DOM — the point of this file is the seal's OWN behaviour, not layout.
 */
function runHarness(
  options: {
    readonly stubs?: readonly { readonly match: string; readonly respond: unknown }[];
  } = {},
): { readonly window: Record<string, unknown> } {
  const window: Record<string, unknown> = {};
  const document = {
    fonts: { ready: Promise.resolve() },
    documentElement: { scrollWidth: 0, scrollHeight: 0 },
    body: { contains: () => false },
    querySelector: () => null,
  };
  const navigator: Record<string, unknown> = {};
  const script = harnessScript({
    stubs: (options.stubs ?? []) as never,
    now: '2026-03-04T09:00:00.000Z',
    timeZone: 'UTC',
  });
  const run = new Function(
    'window',
    'document',
    'navigator',
    'requestAnimationFrame',
    `${script}\nreturn window;`,
  ) as (win: unknown, doc: unknown, nav: unknown, raf: unknown) => Record<string, unknown>;
  const result = run(window, document, navigator, () => 0);
  return { window: result };
}

describe('unit · a live socket must not fail every state of a live island', () => {
  test('constructing window.WebSocket does not throw', () => {
    const { window } = runHarness();
    const WS = window.WebSocket as new (url: string) => unknown;
    expect(() => new WS('ws://127.0.0.1:8788/_x/sync')).not.toThrow();
  });

  test('constructing window.EventSource does not throw', () => {
    const { window } = runHarness();
    const ES = window.EventSource as new (url: string) => unknown;
    expect(() => new ES('http://127.0.0.1:8788/_x/events')).not.toThrow();
  });

  test('a constructed socket never reports itself as an unstubbed request', () => {
    const { window } = runHarness();
    const WS = window.WebSocket as new (url: string) => unknown;
    const ES = window.EventSource as new (url: string) => unknown;
    new WS('ws://127.0.0.1:8788/_x/sync');
    new ES('http://127.0.0.1:8788/_x/events');
    const state = window[HARNESS_GLOBAL] as { unstubbed: readonly string[] };
    expect(state.unstubbed).toEqual([]);
  });

  test('close() is callable and a no-op — a component that tears down on unmount must not throw', () => {
    const { window } = runHarness();
    const WS = window.WebSocket as new (url: string) => { close(): void };
    const socket = new WS('ws://127.0.0.1:8788/_x/sync');
    expect(() => socket.close()).not.toThrow();
  });

  test('a real unstubbed HTTP request is still refused — the refusal is not weakened', () => {
    const { window } = runHarness();
    const fetchFn = window.fetch as (url: string) => Promise<unknown>;
    expect(fetchFn('/api/nope')).rejects.toThrow(/no stub answers/);
  });

  test('a socket is recorded on its own list, and the probe carries it beside unstubbed', () => {
    const { window } = runHarness();
    const WS = window.WebSocket as new (url: string) => unknown;
    new WS('ws://127.0.0.1:8788/_x/sync');
    const document = {
      querySelector: () => null,
      documentElement: { scrollWidth: 0, scrollHeight: 0 },
    };
    const probe = new Function(
      'window',
      'document',
      `return ${readinessProbe('[data-x-island]')};`,
    ) as (
      win: unknown,
      doc: unknown,
    ) => { unstubbed: readonly string[]; sockets: readonly string[] };
    const seen = probe(window, document);
    expect(seen.unstubbed).toEqual([]);
    expect(seen.sockets).toEqual(['WS ws://127.0.0.1:8788/_x/sync']);
  });
});

describe('unit · the printed fix for an unstubbed request must be satisfiable', () => {
  test('a fetch/XHR request that goes unstubbed prints a fix whose match the grammar accepts', () => {
    const error = new IslandRequestUnstubbedError({
      island: 'apps/web/app/settings/settings.island.tsx',
      state: 'default',
      requests: ['GET /api/quota'],
      statesFile: 'apps/web/app/settings/settings.island.states.ts',
    });
    const match = /match: '([^']+)'/.exec(error.fix)?.[1];
    expect(match).toBeDefined();
    expect(isStubMatch(match as string)).toBe(true);
  });

  // Before the fix, a live socket's own address WAS the entry the harness recorded, and
  // `IslandRequestUnstubbedError`'s `fix:` names `requests[0]` verbatim — so a run that ever
  // reached this constructor with a socket entry printed a command `isStubMatch` refuses on
  // its face. This is that scenario, held here so a regression that reopens the WS/SSE path
  // to `unstubbed` is caught even though the harness itself no longer produces one.
  test('a socket entry, if it ever reached this error, would print an unsatisfiable fix', () => {
    const error = new IslandRequestUnstubbedError({
      island: 'apps/web/app/settings/settings.island.tsx',
      state: 'default',
      requests: ['WS ws://127.0.0.1:8788/_x/sync'],
      statesFile: 'apps/web/app/settings/settings.island.states.ts',
    });
    const match = /match: '([^']+)'/.exec(error.fix)?.[1];
    expect(match).toBeDefined();
    expect(isStubMatch(match as string)).toBe(false);
  });
});
