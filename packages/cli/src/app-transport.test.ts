// The browser-transport rule over an app ON DISK, laid out the way an install leaves it:
// `node_modules/@ultimat3/*` is a real directory holding the framework's own seam file — which
// calls `globalThis.fetch` — and the walk must end at that boundary instead of reporting it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no API for creating or removing a temporary directory.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path joiner; `Bun.write` takes a path already joined.
import { join, resolve } from 'node:path';
import { readAppSources } from './app-boundaries';
import { appTransportFindings } from './app-transport';
import { appBoundaryFindings } from './boundary-findings';
import { browserEntries } from './browser-transport';

const FILES: Readonly<Record<string, string>> = {
  // JSONC, as a tsconfig is allowed to be: a strict parse would leave the app with no aliases.
  'tsconfig.json': `{
  // the app's own packages
  "compilerOptions": {
    "paths": {
      "@demo/web/*": ["./apps/web/*"],
      "@demo/*": ["./packages/*/src"],
    },
  },
}`,
  'packages/ui/package.json': '{ "name": "@demo/ui", "exports": { ".": "./src/index.ts" } }',
  'packages/ui/src/index.ts':
    "export { Button } from './button';\nexport { chart } from './chart';\n",
  'packages/ui/src/button.tsx': 'export const Button = () => null;\n',
  'packages/ui/src/chart.ts':
    "// loads the series\nexport const chart = () => fetch('/api/series');\n",
  // Resolved by its MANIFEST alone: the tsconfig pattern above points at a directory with no src.
  'packages/kit/package.json': '{ "name": "@kit/charts", "exports": { "./*": "./lib/*.ts" } }',
  'packages/kit/lib/socket.ts': "export const open = () => new WebSocket('/ws');\n",
  // The installed framework: real directories, and the fetch seam really calls fetch.
  'node_modules/@ultimat3/core/package.json':
    '{ "name": "@ultimat3/core", "exports": { ".": "./src/index.ts", "./page": "./src/page.ts" } }',
  'node_modules/@ultimat3/core/src/page.ts':
    "export { clientTransport } from './client-dispatch';\n",
  'node_modules/@ultimat3/core/src/client-dispatch.ts':
    'export const clientTransport = (r: Request) => globalThis.fetch(r);\n',
  'node_modules/@ultimat3/storage/package.json':
    '{ "name": "@ultimat3/storage", "exports": { ".": "./src/index.ts" } }',
  'node_modules/@ultimat3/storage/src/index.ts':
    'export const uploadFile = () => new XMLHttpRequest();\n',
  'node_modules/@ultimat3/entity/package.json':
    '{ "name": "@ultimat3/entity", "exports": { ".": "./src/index.ts", "./record": "./src/record.ts" } }',
  // Clean islands: the framework's transport, the upload client, a NAME from the ui barrel whose
  // sibling calls fetch, and a relative climb into the installed package.
  'apps/web/app/ok/transport.island.tsx':
    "import { clientTransport } from '@ultimat3/core/page';\nexport const load = () => clientTransport({ method: 'GET', url: '/x' });\n",
  'apps/web/app/ok/upload.island.tsx':
    "import { uploadFile } from '@ultimat3/storage';\nexport const up = uploadFile;\n",
  'apps/web/app/ok/button.island.tsx':
    "import { Button } from '@demo/ui';\nexport const B = Button;\n",
  'apps/web/app/ok/climb.island.tsx':
    "import { clientTransport } from '../../../../node_modules/@ultimat3/core/src/client-dispatch';\nexport const c = clientTransport;\n",
  // The same raw fetch, in server code no island reaches.
  'apps/web/api/hook/route.ts': "export const POST = () => fetch('https://vendor.test/hook');\n",
  'apps/web/app/ok/ok.island.test.tsx': "await fetch('/only-in-a-test');\n",
};

const BROKEN: Readonly<Record<string, string>> = {
  'apps/web/app/bad/fetch.island.tsx': "export const A = () => null;\n\nawait fetch('/api/x');\n",
  'apps/web/app/bad/socket.island.tsx': "import { open } from '@kit/charts/socket';\nopen();\n",
  'apps/web/app/bad/xhr.island.tsx': 'const x = new XMLHttpRequest();\n',
  'apps/web/app/bad/chart.island.tsx': "import { chart } from '@demo/ui';\nchart();\n",
  'apps/web/app/bad/alias.island.tsx': "import { load } from '@demo/web/shared/load';\nload();\n",
  'apps/web/shared/load.ts': "export const load = () => window.fetch('/api/y');\n",
  'apps/web/app/bad/barrel.island.tsx': "import { recordKey } from '@ultimat3/entity';\n",
};

async function appAt(files: Readonly<Record<string, string>>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-app-transport-'));
  await Promise.all(
    Object.entries(files).map(([path, contents]) => Bun.write(join(root, path), contents)),
  );
  return root;
}

const located = (findings: readonly { readonly code: string; readonly at?: string }[]): string[] =>
  findings.map((finding) => `${finding.code} ${finding.at ?? ''}`).sort();

describe('the browser-transport rule over an app on disk', () => {
  let clean = '';
  let broken = '';
  beforeAll(async () => {
    clean = await appAt(FILES);
    broken = await appAt({ ...FILES, ...BROKEN });
  });
  afterAll(() => {
    for (const root of [clean, broken]) rmSync(root, { recursive: true, force: true });
  });

  test('the walk ends at node_modules: the framework`s own seam is trusted, never reported', async () => {
    const files = await readAppSources(clean);
    // Non-vacuity: the four clean islands are entries, so the closure really ran.
    expect(browserEntries(new Map(files.map((f) => [f.path, f.source])))).toHaveLength(4);
    expect(await appTransportFindings(clean, files)).toEqual([]);
  });

  test('one finding per raw transport, at the line it is on, in the file that holds it', async () => {
    const findings = await appTransportFindings(broken, await readAppSources(broken));
    expect(located(findings)).toEqual([
      'X_BROWSER_SERVER_BARREL apps/web/app/bad/barrel.island.tsx:1',
      'X_BROWSER_TRANSPORT_BYPASS apps/web/app/bad/fetch.island.tsx:3',
      'X_BROWSER_TRANSPORT_BYPASS apps/web/app/bad/xhr.island.tsx:1',
      // Through the tsconfig alias, into the app's own surface.
      'X_BROWSER_TRANSPORT_BYPASS apps/web/shared/load.ts:1',
      // Through the workspace manifest's `./*` export, read from disk on demand.
      'X_BROWSER_TRANSPORT_BYPASS packages/kit/lib/socket.ts:1',
      // Through the tsconfig `*` pattern and the barrel, by NAME.
      'X_BROWSER_TRANSPORT_BYPASS packages/ui/src/chart.ts:2',
    ]);
  });

  test('an app is told the framework`s function, and the gate step that re-reads it', async () => {
    const findings = await appTransportFindings(broken, await readAppSources(broken));
    const fetched = findings.find((f) => f.at === 'apps/web/app/bad/fetch.island.tsx:3');
    expect(fetched?.cause).toContain("only @ultimat3/core's clientTransport may");
    expect(fetched?.fix).toStartWith('x verify --only boundaries --json   # ');
    const xhr = findings.find((f) => f.at === 'apps/web/app/bad/xhr.island.tsx:1');
    expect(xhr?.cause).toContain("only @ultimat3/storage's uploadFile may");
    const socket = findings.find((f) => f.at === 'packages/kit/lib/socket.ts:1');
    expect(socket?.cause).toContain("only @ultimat3/realtime's page socket may");
  });

  test('the gate step`s own function carries it', async () => {
    const expected = located(await appTransportFindings(broken, await readAppSources(broken)));
    expect(expected.length).toBeGreaterThan(0);
    expect(located(await appBoundaryFindings(broken))).toEqual(expected);
  });

  test('an app with no island has no finding: a route`s fetch is server code', async () => {
    const root = await appAt({
      'tsconfig.json': '{ this is not json',
      'apps/web/api/hook/route.ts': "export const POST = () => fetch('https://vendor.test');\n",
    });
    try {
      expect(await appTransportFindings(root, await readAppSources(root))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unreadable tsconfig and no install leave the islands` own calls reported', async () => {
    const root = await appAt({
      'tsconfig.json': '{ this is not json',
      'apps/web/app/a/a.island.tsx': "await fetch('/api/x');\n",
    });
    try {
      const findings = await appTransportFindings(root, await readAppSources(root));
      expect(located(findings)).toEqual([
        'X_BROWSER_TRANSPORT_BYPASS apps/web/app/a/a.island.tsx:1',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the tracked apps', () => {
  const REPO = resolve(import.meta.dir, '../../..');

  test('the reference app has islands, and every one of them uses the one transport', async () => {
    const root = join(REPO, 'examples/dummy');
    const files = await readAppSources(root);
    expect(browserEntries(new Map(files.map((f) => [f.path, f.source]))).length).toBeGreaterThan(0);
    expect(await appTransportFindings(root, files)).toEqual([]);
  });

  test('the demo app ships no island, so the rule has nothing to read', async () => {
    const root = join(REPO, 'dummy/social-media-clone');
    expect(await appTransportFindings(root, await readAppSources(root))).toEqual([]);
  });
});
