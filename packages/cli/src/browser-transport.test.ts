// The browser-transport rule over a tree, in the shape an APP has: islands, routes, the app's own
// files — and the framework behind a package boundary the walk does not cross. One failing island
// per transport, and every case the rule must leave alone.

import { describe, expect, test } from 'bun:test';
import type { FindingContext, TransportInput } from './browser-transport';
import {
  barrelFinding,
  browserEntries,
  bypassFinding,
  checkBrowserTransport,
} from './browser-transport';
import { fixSequenceProblem } from './fix-sequence';
import { serverBarrels } from './server-barrels';

const APP: FindingContext = {
  holder: (shape) => (shape === 'fetch' ? "@ultimat3/core's clientTransport" : undefined),
  rerun: 'x verify --only boundaries --json',
};

/** An app tree: nothing under `@ultimat3/*` resolves, exactly as behind `node_modules`. */
function app(files: Record<string, string>, extra: Partial<TransportInput> = {}): TransportInput {
  const map = new Map(Object.entries(files));
  return {
    entries: browserEntries(map),
    host: { read: (path) => map.get(path), alias: () => undefined },
    seams: new Map(),
    barrels: serverBarrels(['@ultimat3/entity', '@ultimat3/entity/record']),
    ...extra,
  };
}

const sites = (input: TransportInput): readonly string[] =>
  checkBrowserTransport(input).bypasses.map((b) => `${b.file}:${b.line} ${b.shape}`);

describe('a raw request in an island', () => {
  test.each([
    ['fetch', "await fetch('/api/x');", 'fetch'],
    ['WebSocket', "const s = new WebSocket('/ws');", 'websocket'],
    ['XMLHttpRequest', 'const x = new XMLHttpRequest();', 'xhr'],
    ['EventSource', "const e = new EventSource('/sse');", 'eventsource'],
  ])('%s is a finding with its line', (_name, call, shape) => {
    const input = app({ 'apps/web/app/a/a.island.tsx': `const one = 1;\n\n${call}\n` });
    expect(sites(input)).toEqual([`apps/web/app/a/a.island.tsx:3 ${shape}`]);
  });

  test('is reported where the call IS — in the file the island imports, not the island', () => {
    const input = app({
      'apps/web/app/a/a.island.tsx': "import { load } from '../../shared/load';\nload();\n",
      'apps/web/shared/load.ts': "export const load = () => fetch('/api/x');\n",
    });
    expect(sites(input)).toEqual(['apps/web/shared/load.ts:1 fetch']);
  });

  test('in an app no file is a seam: the exemption is the framework`s, behind the boundary', () => {
    const input = app({
      'apps/web/shared/client-dispatch.ts': 'export const f = () => globalThis.fetch(u);\n',
      'apps/web/app/a/a.island.tsx': "import { f } from '../../shared/client-dispatch';\n",
    });
    expect(sites(input)).toEqual(['apps/web/shared/client-dispatch.ts:1 fetch']);
  });
});

describe('the global fetch handed to a client module', () => {
  test('is a finding in the island that hands it on, beside any call', () => {
    const input = app({
      'apps/web/app/a/a.island.tsx':
        "import { makeClient } from '../../shared/api';\nconst api = makeClient({ fetch });\n",
      'apps/web/shared/api.ts': 'export const makeClient = (o: O) => o;\n',
    });
    expect(sites(input)).toEqual(['apps/web/app/a/a.island.tsx:2 fetch']);
    expect(checkBrowserTransport(input).bypasses[0]?.passed).toBe(true);
  });

  test('the seam file may hold the global as a value too', () => {
    const files = { 'packages/core/src/d.island.tsx': 'const f = globalThis.fetch;\n' };
    expect(sites(app(files))).toEqual(['packages/core/src/d.island.tsx:1 fetch']);
    const seams = new Map([['fetch', 'packages/core/src/d.island.tsx'] as const]);
    expect(sites(app(files, { seams }))).toEqual([]);
  });
});

describe('what the rule leaves alone', () => {
  test('the same fetch in a route.ts — server code no island reaches', () => {
    const input = app({
      'apps/web/api/hook/route.ts': "export const POST = () => fetch('https://vendor.test');\n",
      'apps/web/app/a/a.island.tsx': 'export const A = () => null;\n',
    });
    expect(sites(input)).toEqual([]);
  });

  test("an island uploading through @ultimat3/storage's upload client", () => {
    const input = app({
      'apps/web/app/a/upload.island.tsx':
        "import { uploadFile } from '@ultimat3/storage';\nimport { browserClient } from '../../shared/browser-client';\nexport const up = (file: File) => uploadFile({ file, grant: browserClient.grantUpload });\n",
      'apps/web/shared/browser-client.ts':
        "import { rpc } from '@ultimat3/action';\nexport const browserClient = rpc({ baseUrl: '' });\n",
    });
    const { reachable, bypasses } = checkBrowserTransport(input);
    expect(bypasses).toEqual([]);
    // Non-vacuity: the island and its client were read; the framework was not.
    expect(reachable).toEqual([
      'apps/web/app/a/upload.island.tsx',
      'apps/web/shared/browser-client.ts',
    ]);
  });

  test('a test file, an `import type`, and a file no island imports', () => {
    const input = app({
      'apps/web/app/a/a.island.tsx': "import type { S } from './server';\n",
      'apps/web/app/a/a.island.test.tsx': "await fetch('/x');\n",
      'apps/web/app/a/server.ts': "export const s = fetch('/x');\n",
      'apps/web/app/a/job.ts': "export const j = fetch('/x');\n",
    });
    expect(sites(input)).toEqual([]);
  });

  test('a file the caller names exempt — a service worker has no page to bypass', () => {
    const files = {
      'apps/web/app/a/a.island.tsx': "import './sw';\n",
      'apps/web/app/a/sw.ts': 'self.fetch(req);\n',
    };
    expect(sites(app(files))).toEqual(['apps/web/app/a/sw.ts:1 fetch']);
    expect(sites(app(files, { exempt: new Set(['apps/web/app/a/sw.ts']) }))).toEqual([]);
  });
});

describe('where the closure starts', () => {
  test('every island, and a module that names the client seam itself', () => {
    const files = new Map([
      ['apps/web/app/a/a.island.tsx', ''],
      [
        'apps/web/shared/api.ts',
        "import { clientTransport } from '@ultimat3/core/page';\nclientTransport({ method: 'GET', url });\n",
      ],
      ['apps/web/shared/plain.ts', 'export const x = 1;\n'],
      ['apps/web/app/a/b.island.test.tsx', ''],
      // A template that EMITS the seam into somebody else's file is not browser code.
      ['apps/web/shared/emit.ts', 'export const t = `await clientTransport({ url })`;\n'],
    ]);
    expect(browserEntries(files)).toEqual([
      'apps/web/app/a/a.island.tsx',
      'apps/web/shared/api.ts',
    ]);
    // A caller may narrow which non-island files count; an island always does.
    expect(browserEntries(files, () => false)).toEqual(['apps/web/app/a/a.island.tsx']);
  });
});

describe('a server barrel in an island`s closure', () => {
  test('is X_BROWSER_SERVER_BARREL, and the fix names the browser entry', () => {
    const input = app({
      'apps/web/app/a/r.island.tsx': "\nimport { recordKey } from '@ultimat3/entity';\n",
    });
    const { barrels } = checkBrowserTransport(input);
    expect(barrels).toEqual([
      {
        file: 'apps/web/app/a/r.island.tsx',
        line: 2,
        barrel: '@ultimat3/entity',
        entry: '@ultimat3/entity/record',
        chain: ['apps/web/app/a/r.island.tsx'],
        names: ['recordKey'],
        swaps: true,
      },
    ]);
    const finding = barrelFinding(barrels[0] ?? expect.unreachable('no barrel'), APP);
    expect(finding.code).toBe('X_BROWSER_SERVER_BARREL');
    expect(finding.at).toBe('apps/web/app/a/r.island.tsx:2');
    expect(finding.fix).toBe(
      "edit apps/web/app/a/r.island.tsx:2 — change the import from '@ultimat3/entity' to '@ultimat3/entity/record'",
    );
  });

  // FX1: the barrel three hops below the island was blamed on the module it landed in, and the
  // swap printed for it does not compile — that module needs the server half.
  const DEEP = {
    'apps/web/app/a/r.island.tsx': "import { pick } from './x';\nimport { list } from './repo';\n",
    'apps/web/app/a/x.ts': 'export const pick = 1;\n',
    'apps/web/app/a/repo.ts': "import { db } from './db';\nexport const list = db;\n",
    'apps/web/app/a/db.ts':
      "\nimport { entity } from '@ultimat3/entity';\nexport const db = entity;\n",
  };

  test('a barrel below the island carries the chain from the island and the hop to cut', () => {
    const [site] = checkBrowserTransport(app(DEEP)).barrels;
    expect(site?.chain).toEqual([
      'apps/web/app/a/r.island.tsx',
      'apps/web/app/a/repo.ts',
      'apps/web/app/a/db.ts',
    ]);
    expect(site?.hop).toEqual({ spec: './repo', line: 2 });
    expect(site?.names).toEqual(['entity']);
  });

  test('server-only names below the island: the fix deletes the island`s import, never swaps', () => {
    for (const published of [undefined, new Map([['@ultimat3/entity/record', new Set(['k'])]])]) {
      const input = app(DEEP, published === undefined ? {} : { published });
      const site = checkBrowserTransport(input).barrels[0] ?? expect.unreachable('no barrel');
      expect(site.swaps).toBe(false);
      const finding = barrelFinding(site, APP);
      expect(finding.at).toBe('apps/web/app/a/r.island.tsx:2');
      expect(finding.fix).toStartWith(
        "edit apps/web/app/a/r.island.tsx:2 — delete the import of './repo'",
      );
      expect(finding.cause).toContain(
        'r.island.tsx → apps/web/app/a/repo.ts → apps/web/app/a/db.ts',
      );
      expect(finding.meta?.['entry']).toBe('apps/web/app/a/r.island.tsx');
    }
  });

  test('a browser helper taking only what the entry publishes is swapped where it stands', () => {
    const published = new Map([['@ultimat3/entity/record', new Set(['entity'])]]);
    const site =
      checkBrowserTransport(app(DEEP, { published })).barrels[0] ?? expect.unreachable('none');
    const finding = barrelFinding(site, APP);
    expect(finding.at).toBe('apps/web/app/a/db.ts:2');
    expect(finding.fix).toContain("from '@ultimat3/entity' to '@ultimat3/entity/record'");
  });

  test('two islands reaching one barrel are two cuts, one in each', () => {
    const files = { ...DEEP, 'apps/web/app/b/b.island.tsx': "import { list } from '../a/repo';\n" };
    const findings = checkBrowserTransport(app(files)).barrels.map((one) =>
      barrelFinding(one, APP),
    );
    expect(findings.map((one) => one.at).sort()).toEqual([
      'apps/web/app/a/r.island.tsx:2',
      'apps/web/app/b/b.island.tsx:1',
    ]);
  });

  test('a package`s own module importing its own barrel is not paying for a server half', () => {
    const files = { 'packages/x/src/a.island.tsx': "import { k } from '@ultimat3/entity';\n" };
    expect(checkBrowserTransport(app(files)).barrels).toHaveLength(1);
    expect(checkBrowserTransport(app(files, { ownsBarrel: () => true })).barrels).toEqual([]);
  });
});

describe('the finding is an instruction', () => {
  const bypassOf = (source: string) =>
    checkBrowserTransport(app({ 'apps/web/app/a/a.island.tsx': source })).bypasses[0] ??
    expect.unreachable('no bypass');

  test('it leads with the edit, and the gate step re-reads after it', () => {
    const finding = bypassFinding(bypassOf("await fetch('/api/x');\n"), APP);
    expect(finding.code).toBe('X_BROWSER_TRANSPORT_BYPASS');
    expect(finding.at).toBe('apps/web/app/a/a.island.tsx:1');
    expect(finding.fix).toStartWith('edit apps/web/app/a/a.island.tsx:1 — replace fetch with ');
    expect(finding.fix).toEndWith('; then x verify --only boundaries --json');
    expect(fixSequenceProblem(finding.fix)).toBeUndefined();
    expect(finding.cause).toContain("only @ultimat3/core's clientTransport may");
    expect(finding.docs).toStartWith('https://');
  });

  test('a fetch names all four replacements, each a line to paste', () => {
    const { fix } = bypassFinding(bypassOf("await fetch('/api/x');\n"), APP);
    expect(fix).toContain('`await browserClient.<action>(input)`');
    expect(fix).toContain("`useQuery(<QUERY_REF>, input)` from '@ultimat3/realtime'");
    expect(fix).toContain("`await uploadFile({ file, grant })` from '@ultimat3/storage'");
    expect(fix).toContain(
      "`await clientTransport({ method: 'GET', url })` from '@ultimat3/core/page'",
    );
  });

  test('a socket is sent to the page`s one socket, an XHR to the upload client', () => {
    const socket = bypassFinding(bypassOf('new WebSocket(u);\n'), APP);
    expect(socket.fix).toContain('`useChannel(<CHANNEL_REF>, params, { onEvent })`');
    // No holder for this shape in the context: nothing may.
    expect(socket.cause).toContain('no module may');
    const xhr = bypassFinding(bypassOf('new XMLHttpRequest();\n'), APP);
    expect(xhr.fix).toContain('`await uploadFile({ file, grant, onProgress })`');
    const sse = bypassFinding(bypassOf('new EventSource(u);\n'), APP);
    expect(sse.fix).toContain("from '@ultimat3/realtime'");
  });

  test('a fetch passed on says so, and the fix removes the hand-off', () => {
    const finding = bypassFinding(bypassOf('const api = makeClient({ fetch });\n'), APP);
    expect(finding.code).toBe('X_BROWSER_TRANSPORT_BYPASS');
    expect(finding.cause).toStartWith(
      'apps/web/app/a/a.island.tsx:1 passes the global fetch as a value in browser-reachable code',
    );
    expect(finding.fix).toStartWith('edit apps/web/app/a/a.island.tsx:1 — delete fetch ');
    expect(fixSequenceProblem(finding.fix)).toBeUndefined();
    expect(finding.fix).toContain('`await browserClient.<action>(input)`');
  });

  test('a path holding a newline cannot end the comment it rides in', () => {
    const hostile = {
      file: 'apps/web/a\nrm -rf ~/x.island.tsx',
      line: 1,
      shape: 'fetch' as const,
      spelled: 'fetch',
    };
    const finding = bypassFinding(hostile, APP);
    expect(finding.fix.split('\n')).toHaveLength(1);
    expect(finding.cause.split('\n')).toHaveLength(1);
    expect(finding.fix).toContain('apps/web/a\\u000arm -rf ~/x.island.tsx:1');
  });
});
