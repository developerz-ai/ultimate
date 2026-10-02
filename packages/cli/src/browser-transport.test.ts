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
      },
    ]);
    const finding = barrelFinding(barrels[0] ?? expect.unreachable('no barrel'), APP);
    expect(finding.code).toBe('X_BROWSER_SERVER_BARREL');
    expect(finding.at).toBe('apps/web/app/a/r.island.tsx:2');
    expect(finding.fix).toBe(
      "x verify --only boundaries --json   # after changing the import at apps/web/app/a/r.island.tsx:2 from '@ultimat3/entity' to '@ultimat3/entity/record'",
    );
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

  test('it runs as written: the gate step first, the edit behind a #', () => {
    const finding = bypassFinding(bypassOf("await fetch('/api/x');\n"), APP);
    expect(finding.code).toBe('X_BROWSER_TRANSPORT_BYPASS');
    expect(finding.at).toBe('apps/web/app/a/a.island.tsx:1');
    expect(finding.fix).toStartWith(
      'x verify --only boundaries --json   # after replacing fetch at apps/web/app/a/a.island.tsx:1 with ',
    );
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
