// The enforcement half of `scripts/browser-transport.ts`: the gate's `unit` step runs every
// `scripts/**/*.test.ts`, so a raw `fetch(` or a page-owned socket in browser-reachable code fails
// `bun run verify` with no extra wiring. Every false positive the plan names is a fixture below —
// a noisy rule is a rule its readers switch off.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { TransportTree } from './browser-transport';
import {
  barrelFinding,
  bypassFinding,
  checkBrowserTransport,
  readTransportTree,
  seamFindings,
  TRANSPORT_SEAMS,
  transportResult,
} from './browser-transport';
import { importClosure } from './lib/import-closure';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { barrelImports, serverBarrels } from './lib/server-barrels';
import { transportCalls } from './lib/transport-calls';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const shapes = (source: string): readonly string[] =>
  transportCalls(source).map((call) => `${call.shape}:${call.spelled}`);

const FETCH_SEAM = TRANSPORT_SEAMS.get('fetch') ?? '';
const SEAM_SOURCE = 'const browserFetch = (i, n) => globalThis.fetch(i, n);\n';

const tree = (files: Record<string, string>): TransportTree => ({
  files: new Map(Object.entries({ [FETCH_SEAM]: SEAM_SOURCE, ...files })),
  aliases: new Map([
    ['@ultimat3/action', 'packages/action/src/index.ts'],
    ['@ultimat3/core', 'packages/core/src/index.ts'],
  ]),
  prefixes: new Map([['@app/web/', 'examples/app/apps/web/']]),
});

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

  test('a local binding named fetch shadows the global — the idempotency-postgres shape', () => {
    const source =
      'const fetch = async (key: string) => rows.get(key);\nconst e = await fetch(key);';
    expect(shapes(source)).toEqual([]);
    expect(shapes('const load = async (fetch: F, key: string) => fetch(key);')).toEqual([]);
    // ...and never through the global object, which no local shadows.
    expect(shapes('const fetch = f;\nglobalThis.fetch(u);')).toEqual(['fetch:globalThis.fetch']);
  });

  test('a name that merely starts with fetch, a string and a comment are not calls', () => {
    expect(shapes('await fetchSignedPut(input);')).toEqual([]);
    expect(shapes("const msg = 'never call fetch( here';")).toEqual([]);
    expect(shapes('// fetch(url) would bypass the store\nconst x = 1;')).toEqual([]);
  });
});

describe('browser-reachable is followed name by name through a barrel', () => {
  const barrel = tree({
    'packages/action/src/index.ts':
      "import './errors';\nexport { rpc } from './client';\nexport { toRoute } from './http';\n",
    'packages/action/src/errors.ts': 'export const E = 1;\n',
    'packages/action/src/client.ts': "import { clientTransport } from '@ultimat3/core';\n",
    'packages/action/src/http.ts': 'export const toRoute = () => fetch(u);\n',
    'packages/core/src/index.ts': "export { clientTransport } from './client-transport';\n",
    'packages/core/src/client-transport.ts': "import { d } from './client-dispatch';\n",
  });
  const host = {
    read: (path: string) => barrel.files.get(path),
    alias: (spec: string) => barrel.aliases.get(spec),
  };

  test('a named import reaches the module the name lives in, and not its siblings', () => {
    const reached = importClosure(host, ['x.island.tsx']);
    expect(reached).toEqual([]);
    const withIsland = tree({
      ...Object.fromEntries(barrel.files),
      'examples/app/apps/web/x.island.tsx': "import { rpc } from '@ultimat3/action';\n",
    });
    const { reachable, bypasses } = checkBrowserTransport(withIsland);
    expect(reachable).toContain('packages/action/src/client.ts');
    expect(reachable).toContain('packages/action/src/errors.ts');
    expect(reachable).toContain(FETCH_SEAM);
    // `http.ts` calls fetch and is server code: no island asked for `toRoute`.
    expect(reachable).not.toContain('packages/action/src/http.ts');
    expect(bypasses).toEqual([]);
  });

  test('a namespace import, a dynamic import and an app alias reach the whole module', () => {
    const { bypasses } = checkBrowserTransport(
      tree({
        ...Object.fromEntries(barrel.files),
        'examples/app/apps/web/y.island.tsx':
          "import * as a from '@ultimat3/action';\nconst s = await import('@app/web/sock');\n",
        'examples/app/apps/web/sock.ts': 'export const s = new WebSocket(u);\n',
      }),
    );
    expect(bypasses.map((b) => `${b.file}:${b.shape}`)).toEqual([
      'examples/app/apps/web/sock.ts:websocket',
      'packages/action/src/http.ts:fetch',
    ]);
  });

  test('`import type` runs nothing, so it reaches nothing', () => {
    const { reachable } = checkBrowserTransport(
      tree({
        'examples/app/apps/web/z.island.tsx': "import type { S } from './server-only';\n",
        'examples/app/apps/web/server-only.ts': 'export const s = fetch(u);\n',
      }),
    );
    expect(reachable).not.toContain('examples/app/apps/web/server-only.ts');
  });
});

describe('where each shape may live', () => {
  test('a raw fetch reintroduced in an island is reported with an edit and a re-run', () => {
    const { bypasses } = checkBrowserTransport(
      tree({ 'examples/app/apps/web/settings.island.tsx': 'await fetch("/api/x", { method });\n' }),
    );
    expect(bypasses).toHaveLength(1);
    const finding = bypassFinding(bypasses[0] ?? expect.unreachable('no bypass'));
    expect(finding.code).toBe('X_BROWSER_TRANSPORT_BYPASS');
    expect(finding.at).toBe('examples/app/apps/web/settings.island.tsx:1');
    expect(finding.fix).toContain('<action>.client()');
    expect(finding.fix).toContain('bun run browser-transport --json');
  });

  test('the seam is exempt at its own path only — the exemption is the file, not the shape', () => {
    const island = { 'examples/app/apps/web/a.island.tsx': "import './moved';\n" };
    const moved = checkBrowserTransport(
      tree({ ...island, 'examples/app/apps/web/moved.ts': SEAM_SOURCE }),
    );
    expect(moved.bypasses.map((b) => b.file)).toEqual(['examples/app/apps/web/moved.ts']);
    const xhr = checkBrowserTransport(
      tree({
        'examples/app/apps/web/b.island.tsx':
          "import { up } from '../../../../packages/storage/src/upload-client';\n",
        'packages/storage/src/upload-client.ts': 'export const up = () => new XMLHttpRequest();\n',
      }),
    );
    expect(xhr.bypasses).toEqual([]);
  });

  test('the service worker realm is exempt, a test is skipped, a server-only module is unseen', () => {
    const { bypasses } = checkBrowserTransport(
      tree({
        'packages/pwa/src/w.island.tsx': "import './service-worker';\nimport './strategies';\n",
        'packages/pwa/src/service-worker.ts': 'self.fetch(req);\n',
        'packages/pwa/src/strategies.ts': 'await fetch(req);\n',
        'packages/app/src/a.island.test.tsx': 'await fetch(u);\n',
        'packages/auth/src/oauth-github.ts': 'await fetch(tokenUrl);\n',
      }),
    );
    expect(bypasses).toEqual([]);
  });

  test('a scaffold template that EMITS the seam into an app is not browser code', () => {
    const { entries } = checkBrowserTransport(
      tree({
        'packages/cli/src/templates/form.ts':
          'export const t = `await clientTransport({ url })`;\n',
      }),
    );
    expect(entries).not.toContain('packages/cli/src/templates/form.ts');
  });

  test('a framework module calling the seam is an entry even when no island imports it', () => {
    const { entries, bypasses } = checkBrowserTransport(
      tree({
        'packages/query/src/client.ts':
          "import { clientTransport } from '@ultimat3/core';\nclientTransport(r);\nnew EventSource(u);\n",
      }),
    );
    expect(entries).toContain('packages/query/src/client.ts');
    expect(bypasses.map((b) => b.shape)).toEqual(['eventsource']);
  });

  test('a seam that stopped calling fetch is refused, never read as a clean tree', () => {
    const moved: TransportTree = { ...tree({}), files: new Map([[FETCH_SEAM, 'export {};\n']]) };
    expect(seamFindings(moved).map((f) => f.code)).toEqual(['X_BROWSER_TRANSPORT_UNSCANNED']);
    expect(transportResult(moved).ok).toBe(false);
  });
});

describe('a server barrel in browser-reachable code', () => {
  const RECORD = {
    '@ultimat3/entity': 'packages/entity/src/index.ts',
    '@ultimat3/entity/record': 'packages/entity/src/record.ts',
  };
  const withEntity = (files: Record<string, string>): TransportTree => {
    const base = tree(files);
    return { ...base, aliases: new Map([...base.aliases, ...Object.entries(RECORD)]) };
  };

  test('is derived from a published browser subpath, never from a list', () => {
    const barrels = serverBarrels([
      '@ultimat3/core',
      '@ultimat3/entity',
      '@ultimat3/entity/record',
      '@ultimat3/realtime/server',
    ]);
    expect([...barrels]).toEqual([['@ultimat3/entity', '@ultimat3/entity/record']]);
  });

  test('a value import of the barrel is refused, and the fix names the browser entry', () => {
    const { barrels } = checkBrowserTransport(
      withEntity({
        'examples/app/apps/web/r.island.tsx': "import { recordKey } from '@ultimat3/entity';\n",
        'packages/entity/src/index.ts': "export { recordKey } from './record';\n",
        'packages/entity/src/record.ts': 'export const recordKey = () => 1;\n',
      }),
    );
    expect(barrels.map((b) => `${b.file}:${b.line}`)).toEqual([
      'examples/app/apps/web/r.island.tsx:1',
    ]);
    const finding = barrelFinding(barrels[0] ?? expect.unreachable('no barrel'));
    expect(finding.code).toBe('X_BROWSER_SERVER_BARREL');
    expect(finding.fix).toContain("import from '@ultimat3/entity/record'");
  });

  test('a type-only import, the browser entry itself, and the package`s own modules are not', () => {
    const map = serverBarrels(Object.keys(RECORD));
    expect(barrelImports("import type { Row } from '@ultimat3/entity';", map)).toEqual([]);
    expect(barrelImports("import { type Row } from '@ultimat3/entity';", map)).toEqual([]);
    expect(barrelImports("import { recordKey } from '@ultimat3/entity/record';", map)).toEqual([]);
    expect(barrelImports("const m = await import('@ultimat3/entity');", map)).toHaveLength(1);
    const { barrels } = checkBrowserTransport(
      withEntity({
        'packages/query/src/q.island.tsx': "import './../../entity/src/record';\n",
        'packages/entity/src/record.ts': "import { t } from '@ultimat3/entity';\n",
      }),
    );
    expect(barrels).toEqual([]);
  });
});

describe('the real tree', () => {
  test('the command it names is a script this repo declares', async () => {
    const raw: unknown = await Bun.file(`${repoRoot()}/package.json`).json();
    const scripts = typeof raw === 'object' && raw !== null && 'scripts' in raw ? raw.scripts : {};
    expect(Object.keys(scripts ?? {})).toContain('browser-transport');
  });

  test('has one browser transport — every island reaches the seam and nothing else', async () => {
    const real = await readTransportTree(repoRoot());
    const { entries, reachable } = checkBrowserTransport(real);
    // Non-vacuity: the islands are entries, the closure crosses into the framework, and the seam
    // is in it — a green run over a closure that never left the app would say the same "ok".
    expect(entries.some((path) => path.startsWith('examples/dummy/apps/'))).toBe(true);
    expect(reachable).toContain(FETCH_SEAM);
    expect(reachable).toContain('packages/action/src/client.ts');
    // The entity barrel is on the derived list, or the server-barrel half read nothing.
    expect(serverBarrels(real.aliases.keys()).get('@ultimat3/entity')).toBe(
      '@ultimat3/entity/record',
    );
    expect(transportResult(real).findings).toEqual([]);
  });

  test('would report the seam`s own call from any other path', async () => {
    const real = await readTransportTree(repoRoot());
    const source = real.files.get(FETCH_SEAM) ?? expect.unreachable(`${FETCH_SEAM} not read`);
    expect(transportCalls(source).some((call) => call.shape === 'fetch')).toBe(true);
  });
});
