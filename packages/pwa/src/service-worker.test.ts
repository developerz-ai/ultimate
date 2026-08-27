// What `generateServiceWorker` EMITS, read as text: the rule table and its order, the precache
// manifest, the build-id keying, the capability markers and the refusals. The emitted worker
// executed against a stub `caches`/`fetch` is `service-worker-runtime.test.ts`.

import { describe, expect, test } from 'bun:test';
import { CAPABILITIES, CAPABILITY_SW_MARKERS } from './capabilities';
import { PwaNoOfflineFallbackError, SwScopeInvalidError } from './errors';
import type { RouteRule, ServiceWorkerConfig } from './service-worker';
import { assertScope, generateServiceWorker } from './service-worker';
import type { PwaRoute } from './strategies';

const routes: readonly PwaRoute[] = [
  {
    path: '/',
    surface: 'site',
    mode: 'static',
    offline: 'precache',
    revision: 'aaaa1111',
    bytes: 4_096,
  },
  {
    path: '/pricing',
    surface: 'site',
    mode: 'static',
    offline: 'precache',
    revision: 'bbbb2222',
    bytes: 8_192,
  },
  {
    path: '/blog/:slug',
    surface: 'site',
    mode: 'isr',
    offline: 'runtime',
    dynamic: true,
  },
  { path: '/dashboard', surface: 'app', mode: 'stream', offline: 'runtime' },
  { path: '/reports', surface: 'app', mode: 'ssr', offline: 'precache', revision: 'cccc3333' },
  { path: '/api/posts', surface: 'api', mode: 'ssr', offline: 'network-only' },
];

const config: ServiceWorkerConfig = {
  offline: { fallback: '/offline' },
  capabilities: { push: false, backgroundSync: false, badging: false },
  vapid: { publicKey: 'BKxDemo', subject: 'mailto:ops@example.test' },
};

describe('generateServiceWorker', () => {
  test('is deterministic for identical input', () => {
    const a = generateServiceWorker(routes, config, 'build-1');
    const b = generateServiceWorker(routes, config, 'build-1');
    expect(a.source).toBe(b.source);
    expect(a.source).not.toContain('Date.now()');
  });

  test('derives the runtime strategy from each route render mode', () => {
    const output = generateServiceWorker(routes, config, 'build-1');
    const byPattern = new Map(output.rules.map((rule) => [rule.pattern, rule.strategy]));

    expect(byPattern.get('^/$')).toBe('cache-first');
    expect(byPattern.get('^/blog/[^/]+/?$')).toBe('stale-while-revalidate');
    expect(byPattern.get('^/dashboard/?$')).toBe('stale-while-revalidate');
    // `precache` and `network-first` together, which is not a contradiction: the entry is in the
    // precache so the route answers offline, and online it asks the network first because an
    // authed `app/` document is one actor's own. No `app/` mode maps to `cache-first` — the row
    // that did was `spa`, and serving one member's cached HTML to the next is what it cost.
    expect(byPattern.get('^/reports/?$')).toBe('network-first');
    // api/ renders nothing, so it gets no cache rule at all.
    expect([...byPattern.keys()].some((p) => p.includes('api'))).toBe(false);
  });

  test('caches are keyed by build id, so a preview deploy cannot poison production', () => {
    const production = generateServiceWorker(routes, config, 'abc123def456');
    const preview = generateServiceWorker(routes, config, 'preview-pr-9-abc123');

    expect(production.source).toContain('"x-precache-abc123def456"');
    expect(preview.source).toContain('"x-precache-preview-pr-9-abc123"');
    expect(preview.source).not.toContain('x-precache-abc123def456');
  });

  test('retained build ids survive activation', () => {
    const output = generateServiceWorker(
      routes,
      { ...config, retainBuildIds: ['old-1', 'old-2'] },
      'new-3',
    );
    expect(output.source).toContain('x-precache-old-1');
    expect(output.source).toContain('x-precache-old-2');
    expect(output.source).toContain('caches.delete');
  });

  // The OFF direction iterates the WHOLE table rather than two hand-picked entries.
  // `CAPABILITY_SW_MARKERS` claims it is "checked in BOTH directions ... none of them is when they
  // are all off", and `badging` was the entry that claim did not cover. Iterating means a
  // capability added later is covered by declaring its markers, with no second edit here to forget.
  test('a disabled capability emits no service-worker code for it', () => {
    const off = generateServiceWorker(routes, config, 'build-1');
    const everyMarker = Object.values(CAPABILITY_SW_MARKERS).flat();
    expect(everyMarker.length).toBeGreaterThan(0);
    for (const marker of everyMarker) {
      expect(off.source).not.toContain(marker);
    }

    const on = generateServiceWorker(
      routes,
      { ...config, capabilities: { push: true, backgroundSync: true, badging: true } },
      'build-1',
    );
    for (const capability of ['push', 'backgroundSync', 'badging'] as const) {
      for (const marker of CAPABILITY_SW_MARKERS[capability]) {
        expect(on.source).toContain(marker);
      }
    }
  });

  // `badging` reads like an independent capability — it has its own `CAPABILITIES` entry, its own
  // `CAPABILITY_SW_MARKERS` row, and `resolveCapabilities({ badging: true })` accepts it — but the
  // badge call is emitted ONLY inside the push block (`service-worker.ts` gates it on
  // `push && config.vapid !== undefined`), chained onto `showNotification`. So `badging: true`
  // alone is a flag that changes nothing, which is worth stating rather than discovering. Pinned
  // rather than "fixed": standalone badging is a feature, and inventing one here would be a
  // behaviour change smuggled into a dead-declaration sweep.
  test('badging is a modifier on push, not an independent capability', () => {
    const badgeOnly = generateServiceWorker(
      routes,
      { ...config, capabilities: { push: false, backgroundSync: false, badging: true } },
      'build-1',
    );
    expect(badgeOnly.source).not.toContain('navigator.setAppBadge');
    // Declared enabled all the same — the capability resolver and the emitted worker disagree,
    // and this is the line that says so out loud.
    expect(badgeOnly.capabilities.badging).toBe(true);

    const withPush = generateServiceWorker(
      routes,
      { ...config, capabilities: { push: true, backgroundSync: false, badging: true } },
      'build-1',
    );
    expect(withPush.source).toContain('navigator.setAppBadge');
  });

  test('every proxied request carries the build id header', () => {
    const output = generateServiceWorker(routes, config, 'build-1');
    expect(output.source).toContain('x-ultimate-build');
    expect(output.source).toContain('h.set(BUILD_HEADER,BUILD_ID)');
  });

  test('refuses to generate without an offline fallback', () => {
    expect(() => generateServiceWorker(routes, { offline: {} }, 'build-1')).toThrow(
      PwaNoOfflineFallbackError,
    );
  });

  test('refuses a scope the service worker path cannot control', () => {
    expect(() =>
      generateServiceWorker(routes, { ...config, swPath: '/assets/sw.js', scope: '/' }, 'build-1'),
    ).toThrow(SwScopeInvalidError);
  });
});

/**
 * The emitted `ruleFor` returns the FIRST rule whose pattern matches, so the ORDER of `rules` is
 * the whole routing decision — and nothing in this suite ever resolved a pathname through it. Every
 * other assertion here is `byPattern.get('<the pattern>')`, a lookup keyed by the answer.
 */
const resolve = (rules: readonly RouteRule[], pathname: string): RouteRule | undefined =>
  rules.find((rule) => new RegExp(rule.pattern).test(pathname));

// A generated file's header is read by whoever finds it in a diff, and its `regenerate:` line is
// the one instruction it carries. It named the CALL until 2026-08-27, because `x build` emitted no
// service worker — nothing in the tree called `generateServiceWorker` at all — so `x build` would
// have sent that reader to a command that left the file exactly as they found it.
//
// `packages/cli/src/sw-artifacts.ts` is the caller now (#390), so the instruction is a COMMAND and
// this test asserts the direction it flipped to. The rule is unchanged and is the reason the test
// exists: the header may only name something that really regenerates the file.
describe('the generated header names something that regenerates it', () => {
  test('it names the command that emits this file, and not the function that shapes it', () => {
    const output = generateServiceWorker(routes, config, 'build-1');
    const head = output.source.split('\n').slice(0, 4).join('\n');
    expect(head).toContain('regenerate: x build');
    // A reader who pastes `generateServiceWorker(routes, config, buildId)` into a shell gets
    // nothing; the whole point of the line is that it runs.
    expect(head).not.toContain('generateServiceWorker(');
    expect(head).toContain('build-1');
  });
});

describe('rule order is specificity, not the alphabet', () => {
  // `:` is 0x3A and `*` is 0x2A, so both sort BEFORE every letter under `localeCompare` — which
  // put `/posts/:id` above `/posts/new` and a `/*` catch-all above the entire table.
  const shadowed: readonly PwaRoute[] = [
    { path: '/posts/:id', surface: 'app', mode: 'ssr', offline: 'network-only', dynamic: true },
    { path: '/posts/new', surface: 'app', mode: 'ssr', offline: 'runtime' },
    { path: '/posts', surface: 'site', mode: 'static', offline: 'precache', revision: 'a1' },
  ];

  test('a static route is reached even when a dynamic sibling could match it', () => {
    const output = generateServiceWorker(shadowed, config, 'build-1');
    const rule = resolve(output.rules, '/posts/new');
    expect(rule?.pattern).toBe('^/posts/new/?$');
    // The consequence of getting it wrong: a route the app declared cacheable is served
    // network-only, so offline the user gets the `/offline` document instead of the page.
    expect(rule?.strategy).toBe('network-first');
    expect(rule?.cache).toBe('pages');
  });

  test('the dynamic sibling still answers the ids it exists for', () => {
    const output = generateServiceWorker(shadowed, config, 'build-1');
    expect(resolve(output.rules, '/posts/42')?.pattern).toBe('^/posts/[^/]+/?$');
    expect(resolve(output.rules, '/posts')?.pattern).toBe('^/posts/?$');
  });

  test('a catch-all does not swallow every precached entry in the table', () => {
    const withCatchAll: readonly PwaRoute[] = [
      { path: '/*rest', surface: 'site', mode: 'ssr', offline: 'network-only' },
      { path: '/', surface: 'site', mode: 'static', offline: 'precache', revision: 'a1' },
      { path: '/about', surface: 'site', mode: 'static', offline: 'precache', revision: 'b2' },
      { path: '/blog/new', surface: 'site', mode: 'static', offline: 'precache', revision: 'c3' },
    ];
    const output = generateServiceWorker(withCatchAll, config, 'build-1');

    // Every one of these is downloaded at install; a catch-all first means none is ever looked up.
    for (const [path, pattern] of [
      ['/', '^/$'],
      ['/about', '^/about/?$'],
      ['/blog/new', '^/blog/new/?$'],
    ] as const) {
      expect(resolve(output.rules, path)?.pattern).toBe(pattern);
      expect(resolve(output.rules, path)?.cache).toBe('precache');
    }
    // ...and the catch-all still answers what nothing else claims.
    expect(resolve(output.rules, '/anything/else')?.pattern).toBe('^/.*/?$');
  });

  test('a deeper static path outranks a shallower dynamic one', () => {
    const nested: readonly PwaRoute[] = [
      { path: '/:tenant/settings', surface: 'app', mode: 'ssr', offline: 'runtime' },
      {
        path: '/acme/settings',
        surface: 'app',
        mode: 'static',
        offline: 'precache',
        revision: 'z',
      },
    ];
    const output = generateServiceWorker(nested, config, 'build-1');
    expect(resolve(output.rules, '/acme/settings')?.pattern).toBe('^/acme/settings/?$');
  });

  test('the order is still deterministic — equal specificity falls back to the path', () => {
    const equal: readonly PwaRoute[] = [
      { path: '/beta', surface: 'site', mode: 'static', offline: 'precache', revision: 'b' },
      { path: '/alpha', surface: 'site', mode: 'static', offline: 'precache', revision: 'a' },
    ];
    const forward = generateServiceWorker(equal, config, 'build-1');
    const reversed = generateServiceWorker([...equal].reverse(), config, 'build-1');
    expect(forward.rules.map((r) => r.pattern)).toEqual(reversed.rules.map((r) => r.pattern));
    expect(forward.rules.map((r) => r.pattern)).toEqual(['^/alpha/?$', '^/beta/?$']);
  });

  /**
   * The tie-break is CODE UNITS, never `localeCompare` — this file's header promises
   * byte-identical output for identical input, and `localeCompare` with no locale argument answers
   * from the runtime's ICU default and collation version, so `/Posts` sorts before `/posts` here
   * and after it on a machine with a different ICU. The same rule `@ultimat3/jobs`' `job.ts:359`
   * states for the manifest it emits. `'/Posts'.localeCompare('/posts')` is `1`; `'/Posts' <
   * '/posts'` is `true`.
   */
  test('and the tie-break is code units, so two ICU builds emit one file', () => {
    const cased: readonly PwaRoute[] = [
      { path: '/posts', surface: 'site', mode: 'static', offline: 'precache', revision: 'p' },
      { path: '/Posts', surface: 'site', mode: 'static', offline: 'precache', revision: 'P' },
    ];
    expect(generateServiceWorker(cased, config, 'build-1').rules.map((r) => r.pattern)).toEqual([
      '^/Posts/?$',
      '^/posts/?$',
    ]);
  });
});

/**
 * A `swPath` with no `/` at all made `directory` the empty string, and `scope.startsWith('')` is
 * true for every scope — so the one check that catches "why is my PWA not working" passed
 * vacuously for the config most likely to be wrong.
 */
describe('assertScope', () => {
  test('a relative swPath is refused rather than silently accepted', () => {
    expect(() => assertScope('sw.js', '/admin/')).toThrow(SwScopeInvalidError);
    expect(() => assertScope('assets/sw.js', '/')).toThrow(SwScopeInvalidError);
  });

  test('the refusal names the absolute form to serve it from', () => {
    let fix = '';
    try {
      assertScope('sw.js', '/admin/');
    } catch (error) {
      fix = String((error as { fix?: unknown }).fix);
    }
    expect(fix).toContain('/admin/sw.js');
  });

  test('an absolute path at or above the scope still passes', () => {
    expect(() => assertScope('/sw.js', '/')).not.toThrow();
    expect(() => assertScope('/sw.js', '/admin/')).not.toThrow();
    expect(() => assertScope('/admin/sw.js', '/admin/')).not.toThrow();
  });
});

/**
 * The marker table is a CLAIM about the emitted worker — "this capability ships these bytes" — and
 * until it was checked in both directions it could name code the generator does not write:
 * `shareTarget` listed `/_x/share-target`, which no block has ever emitted, so an installed app
 * declared itself a share target with nothing behind it. A capability with an empty marker list is
 * the honest way to say "manifest member only", the way `fileHandlers` already does.
 */
describe('CAPABILITY_SW_MARKERS against the worker it describes', () => {
  const all: ServiceWorkerConfig = {
    ...config,
    capabilities: {
      push: true,
      backgroundSync: true,
      badging: true,
      shareTarget: true,
      fileHandlers: true,
      protocolHandlers: true,
    },
  };

  test('every marker a capability declares is in the worker when it is enabled', () => {
    const source = generateServiceWorker(routes, all, 'build-1').source;
    const missing = CAPABILITIES.flatMap((capability) =>
      CAPABILITY_SW_MARKERS[capability]
        .filter((marker) => !source.includes(marker))
        .map((marker) => `${capability}: ${marker}`),
    );
    expect(missing).toEqual([]);
  });

  test('none of them is in the worker when every capability is off', () => {
    const source = generateServiceWorker(routes, config, 'build-1').source;
    const leaked = CAPABILITIES.flatMap((capability) =>
      CAPABILITY_SW_MARKERS[capability]
        .filter((marker) => source.includes(marker))
        .map((marker) => `${capability}: ${marker}`),
    );
    expect(leaked).toEqual([]);
  });
});
