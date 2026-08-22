// The verdict is the half that gates, so every rule it states is proved here with no browser and
// no dev server: what makes a shot NOT ok, what the island probe actually counts, and the two
// answers that must never collapse into a zero — an unreadable canvas and an uncounted island.

import { describe, expect, test } from 'bun:test';
import type { ConsoleLine, NetworkEntry, PageError } from '@ultimat3/scraping';
import { messageKeys } from './messages';
import type { ShotInput } from './shot-verdict';
import {
  buildVerdict,
  canvasOf,
  ISLAND_PROBE,
  parseIslandProbe,
  SHOT_MESSAGE_KEYS,
  shotLines,
  shotSummary,
  verdictJson,
} from './shot-verdict';

const line = (level: ConsoleLine['level'], text: string): ConsoleLine => ({ level, text, at: 1 });

const entry = (overrides: Partial<NetworkEntry> = {}): NetworkEntry => ({
  method: 'GET',
  url: 'http://localhost:4321/app',
  resourceType: 'document',
  at: 1,
  ...overrides,
});

const inputFor = (overrides: Partial<ShotInput> = {}): ShotInput => ({
  route: '/app',
  requestedUrl: 'http://localhost:4321/app',
  finalUrl: 'http://localhost:4321/app',
  server: 'booted',
  capturedAt: '2026-08-21T00:00:00.000Z',
  screenshot: 'shot.png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  console: [],
  pageErrors: [],
  pageErrorsDropped: 0,
  network: [entry()],
  networkDropped: 0,
  islands: {
    declared: 2,
    booted: 1,
    mounted: 1,
    failed: 0,
    byStrategy: { idle: 1, never: 1 },
    failures: [],
  },
  ...overrides,
});

/**
 * A 1x1 PNG's first 24 bytes: signature, the IHDR length/type, then width and height as big-endian
 * u32s. Written out rather than base64'd because the two numbers being read are the point.
 */
const pngHeader = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

describe('unit · a shot is not ok just because a picture came back', () => {
  test('a console error fails the verdict and is counted by level', () => {
    const verdict = buildVerdict(
      inputFor({ console: [line('error', 'boom'), line('warn', 'slow'), line('log', 'hi')] }),
    );
    expect([verdict.ok, verdict.errors, verdict.warnings]).toEqual([false, 1, 1]);
  });

  // The failure this field exists for: an `auth: 'required'` route photographs the sign-in page,
  // every island is missing from it, and the report reads as a bug in the app.
  test('a redirect fails the verdict even with a clean console', () => {
    const verdict = buildVerdict(
      inputFor({ finalUrl: 'http://localhost:4321/auth/sign-in', console: [] }),
    );
    expect([verdict.ok, verdict.redirected, verdict.errors]).toEqual([false, true, 0]);
  });

  test('a clean capture of the route that was asked for is ok', () => {
    const verdict = buildVerdict(inputFor({ console: [line('log', 'hydrated')] }));
    expect([verdict.ok, verdict.redirected]).toEqual([true, false]);
  });

  // The half a picture cannot show, and the half the verdict did not read: every island's
  // `mount()` REJECTED, the console is empty because a rejected promise calls no console method,
  // and the run reported `ok: true` — the marker the prelude pays 129 B an island to emit was
  // counted into the artifact and read by nothing.
  test('an island whose mount rejected fails the verdict, with a clean console', () => {
    const verdict = buildVerdict(
      inputFor({
        islands: {
          declared: 2,
          booted: 2,
          mounted: 1,
          failed: 1,
          byStrategy: { idle: 2 },
          failures: [{ island: 'cart', message: 'TypeError: total is not a function' }],
        },
      }),
    );
    expect([verdict.ok, verdict.errors, verdict.pageErrors.length]).toEqual([false, 0, 0]);
  });

  // A `null` probe is "not counted", never "none failed": a page that answered no probe must not
  // be failed by a zero the tool invented.
  test('an uncounted island neither fails the verdict nor passes it as a zero', () => {
    expect(buildVerdict(inputFor({ islands: null })).ok).toBe(true);
  });

  test('a refused request is counted without failing the shot', () => {
    const verdict = buildVerdict(
      inputFor({ network: [entry(), entry({ refused: 'host' }), entry({ refused: 'blocked' })] }),
    );
    expect([verdict.ok, verdict.refused]).toEqual([true, 2]);
  });
});

describe('unit · the canvas is measured, never assumed', () => {
  test('the picture reports its own pixel size', () => {
    expect(canvasOf(pngHeader(1280, 3200))).toEqual({
      width: 1280,
      height: 3200,
      format: 'png',
    });
  });

  // The offline drivers answer a PNG signature with no IHDR behind it. `0x0` would be a size a
  // reader could act on; `null` is the truth.
  test('bytes that are not a decodable image answer null, never a zero size', () => {
    expect(canvasOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
    expect(canvasOf(new Uint8Array(0))).toBeNull();
  });
});

describe('unit · the island probe counts four different facts', () => {
  interface ProbeElement {
    readonly hydrate: string;
    readonly booted: boolean;
    readonly id?: string;
    /** `undefined` = still pending. A string = `mount()` rejected with that message. */
    readonly failed?: string;
    readonly mounted?: boolean;
  }

  /**
   * The probe runs in a browser, so it is run here against the smallest `document` that can answer
   * it. This is what proves the arithmetic — a recorded answer in a fixture proves only that the
   * expression was sent.
   */
  const runProbe = (elements: readonly ProbeElement[]): unknown => {
    const attrs = (element: ProbeElement): Record<string, string | undefined> => ({
      'data-x-hydrate': element.hydrate,
      'data-x-island': element.id ?? '',
      ...(element.mounted === true ? { 'data-x-mounted': '' } : {}),
      ...(element.failed === undefined ? {} : { 'data-x-failed': element.failed }),
    });
    const document = {
      querySelectorAll: (selector: string) =>
        selector === '[data-x-island]'
          ? elements.map((element) => ({
              getAttribute: (name: string) => attrs(element)[name] ?? null,
              hasAttribute: (name: string) => attrs(element)[name] !== undefined,
              __x: element.booted ? Promise.resolve() : undefined,
            }))
          : [],
    };
    return new Function('document', `return ${ISLAND_PROBE};`)(document) as unknown;
  };

  test('declared, booted, mounted and failed are four separate numbers', () => {
    // One of each state a real page reaches: running, threw, requested-but-unsettled, and a
    // `never` island that is CORRECT to have none of the three.
    const answer = runProbe([
      { hydrate: 'idle', booted: true, mounted: true, id: 'a' },
      { hydrate: 'interaction', booted: true, failed: 'boom', id: 'b' },
      { hydrate: 'visible', booted: true, id: 'c' },
      { hydrate: 'never', booted: false, id: 'd' },
    ]);
    expect(parseIslandProbe(answer)).toEqual({
      declared: 4,
      booted: 3,
      mounted: 1,
      failed: 1,
      byStrategy: { idle: 1, interaction: 1, visible: 1, never: 1 },
      failures: [{ island: 'b', message: 'boom' }],
    });
  });

  // The distinction the markers exist for, and the one a picture can never show: `booted` counts
  // both of these and only `mounted`/`failed` tell them apart.
  test('an island that threw and an island still mounting are both booted, and differ', () => {
    const answer = parseIslandProbe(
      runProbe([
        { hydrate: 'idle', booted: true, failed: 'TypeError: x is not a function', id: 'threw' },
        { hydrate: 'idle', booted: true, id: 'pending' },
      ]),
    );
    expect(answer?.booted).toBe(2);
    expect(answer?.mounted).toBe(0);
    expect(answer?.failures).toEqual([
      { island: 'threw', message: 'TypeError: x is not a function' },
    ]);
  });

  test('a page with no islands is a real zero', () => {
    expect(parseIslandProbe(runProbe([]))).toEqual({
      declared: 0,
      booted: 0,
      mounted: 0,
      failed: 0,
      byStrategy: {},
      failures: [],
    });
  });

  // `evaluate()` answers `unknown` on every driver. A cast here would put a string where every
  // reader expects a number and only show up in the artifact.
  test('anything that is not the probe shape parses to null', () => {
    for (const value of [
      null,
      'ok',
      3,
      {},
      { declared: '3', booted: 0, byStrategy: {} },
      // The OLD shape: a probe that predates the mount markers must not parse as a modern answer
      // reporting zero mounts, which would read as "nothing on this page works".
      { declared: 3, booted: 1, byStrategy: {} },
    ]) {
      expect(parseIslandProbe(value)).toBeNull();
    }
  });
});

describe('unit · an uncaught exception is its own gating fact', () => {
  const thrown = (message: string, stack?: string): PageError => ({
    message,
    ...(stack === undefined ? {} : { stack }),
    at: 1_770_000_000_000,
  });

  // The whole reason `x shot` exists, stated as a test: a throw calls NO console method, so this
  // page logs nothing at all. Gating on `errors` alone would call it clean.
  test('a page that threw and logged nothing is not ok', () => {
    const verdict = buildVerdict(
      inputFor({ console: [], pageErrors: [thrown('TypeError: t is not a function')] }),
    );
    expect(verdict.errors).toBe(0);
    expect(verdict.ok).toBe(false);
  });

  test('the summary leads with the throw, ahead of any console count', () => {
    const verdict = buildVerdict(
      inputFor({
        console: [line('error', 'boom')],
        pageErrors: [thrown('ReferenceError: cart is not defined')],
      }),
    );
    expect(shotSummary(verdict)).toContain('ReferenceError: cart is not defined');
  });

  test('the stack survives into the artifact, because it names the island that threw', () => {
    const stack = 'ReferenceError: cart\n    at Cart (/app/islands/cart.tsx:31:18)';
    const json = verdictJson(
      buildVerdict(inputFor({ pageErrors: [thrown('ReferenceError', stack)] })),
    );
    const errors = (json as { pageErrors: { thrown: readonly { stack: string | null }[] } })
      .pageErrors;
    expect(errors.thrown[0]?.stack).toContain('/app/islands/cart.tsx:31:18');
  });

  // A throw is not a console line, and a reader who finds one under `console` looks in the wrong
  // stream for the other.
  test('page errors never appear in the console object', () => {
    const json = verdictJson(
      buildVerdict(inputFor({ console: [], pageErrors: [thrown('boom')] })),
    ) as { console: { total: number }; pageErrors: { total: number } };
    expect([json.console.total, json.pageErrors.total]).toEqual([0, 1]);
  });

  test('dropped page errors make the count a floor, not a total', () => {
    const json = verdictJson(
      buildVerdict(inputFor({ pageErrors: [thrown('boom')], pageErrorsDropped: 7 })),
    ) as { pageErrors: { dropped: number } };
    expect(json.pageErrors.dropped).toBe(7);
  });
});

describe('unit · the artifact says what it does not know', () => {
  test('an uncounted island stays null and never becomes a zero', () => {
    const json = verdictJson(buildVerdict(inputFor({ islands: null }))) as Record<string, unknown>;
    expect(json['islands']).toBeNull();
  });

  test('every verdict names its blind spots', () => {
    const json = verdictJson(buildVerdict(inputFor())) as { blind: readonly string[] };
    // Asserted by CONTENT, not by count: a count derived from `BLIND_SPOTS` would agree with
    // itself forever, and a literal count reds on every edit without saying which claim moved.
    // Response status is the one left — the browser port records requests, never responses.
    expect(json.blind.join(' ')).toContain('status');
    expect(json.blind.length).toBeGreaterThan(0);
  });

  /**
   * Two blind spots were RETIRED on 2026-08-21 — `pageerror` capture landed in
   * `@ultimat3/scraping`, and the hydration prelude began marking a mount's outcome. This asserts
   * the retirement, which is the half that rots: a stale caveat is not harmless, it teaches an
   * agent to distrust an answer the tool can now give and to go look at a picture instead.
   */
  test('the artifact no longer hedges about throws or about whether a mount resolved', () => {
    const blind = (
      verdictJson(buildVerdict(inputFor())) as { blind: readonly string[] }
    ).blind.join(' ');
    expect(blind).not.toContain('mount()');
    expect(blind).not.toContain('pageerror');
  });

  test('the JSON carries the console counts and the bytes the picture weighs', () => {
    const verdict = buildVerdict(inputFor({ console: [line('error', 'boom')] }));
    const json = verdictJson(verdict) as {
      console: { total: number; errors: number };
      bytes: number;
      ok: boolean;
    };
    expect([json.ok, json.console.total, json.console.errors, json.bytes]).toEqual([
      false,
      1,
      1,
      4,
    ]);
  });
});

describe('unit · a failed mount is what the summary leads with', () => {
  const failedIslands = (message: string): Partial<ShotInput> => ({
    islands: {
      declared: 3,
      booted: 2,
      mounted: 1,
      failed: 1,
      byStrategy: { idle: 2, never: 1 },
      failures: [{ island: 'cart', message }],
    },
  });

  test('the summary names the island that failed and what it said', () => {
    const summary = shotSummary(buildVerdict(inputFor(failedIslands('TypeError: total'))));
    expect(summary).toContain('cart');
    expect(summary).toContain('TypeError: total');
  });

  // Ahead of the console count for the same reason a throw is: a rejected mount promise calls no
  // console method, and `errors` alone would report the page clean.
  test('a failed mount outranks a console error and is outranked by a redirect', () => {
    const withError = buildVerdict(
      inputFor({ ...failedIslands('boom'), console: [line('error', 'unrelated')] }),
    );
    expect(shotSummary(withError)).toContain('cart');
    const redirected = buildVerdict(
      inputFor({ ...failedIslands('boom'), finalUrl: 'http://localhost:4321/auth/sign-in' }),
    );
    expect(shotSummary(redirected)).toContain('/auth/sign-in');
  });
});

describe('unit · the human render states the gating fact', () => {
  test('a redirect is what the summary says, ahead of any console count', () => {
    const summary = shotSummary(
      buildVerdict(inputFor({ finalUrl: 'http://localhost:4321/auth/sign-in' })),
    );
    expect(summary).toContain('/auth/sign-in');
  });

  test('the lines name both artifacts and the island count', () => {
    const verdict = buildVerdict(inputFor({ bytes: pngHeader(800, 600) }));
    const lines = shotLines({
      verdict,
      image: '/app/.x/shot/app/shot.png',
      verdictFile: '/app/.x/shot/app/verdict.json',
    });
    expect(lines.join('\n')).toContain('/app/.x/shot/app/verdict.json');
    expect(lines.join('\n')).toContain('800');
  });
});

// RED until `messages.ts` carries these rows — deliberately. `msg()` renders `⟦key⟧` for a miss,
// which is loud in a terminal and silent to a build, so the only mechanism that can see a missing
// row is a test that names the set.
describe('unit · every key x shot renders is in the catalog', () => {
  test('no rendered line falls back to ⟦key⟧', () => {
    const known = new Set(messageKeys());
    expect(SHOT_MESSAGE_KEYS.filter((key) => !known.has(key))).toEqual([]);
  });
});
