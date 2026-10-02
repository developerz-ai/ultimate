// The probe's answer, computed in THIS process rather than read off a child's stdout: a module the
// worker load leaves out is blamed for exactly what importing it registered, and a module the
// worker load already imported is blamed for nothing. `verify-role-load.test.ts` proves the child.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory, a recursive delete or a symlink.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { probeRoleLoad } from './verify-role-load-probe';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

// Service names of this file's own: the service registry is one per process.
const service = (name: string, extra = ''): string =>
  `import { defineService } from '@ultimat3/core';
${extra}export const svc = defineService('${name}', () => ({ ok: true }));
`;

async function fixtureApp(files: Readonly<Record<string, string>>): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-role-load-probe-'));
  symlinkSync(join(import.meta.dir, '..', 'node_modules'), join(root, 'node_modules'));
  for (const [path, source] of Object.entries(files)) await Bun.write(join(root, path), source);
  return root;
}

describe('unit · the role-load probe, in process', () => {
  test('a module the worker leaves out is blamed for what it registered; the rest for nothing', async () => {
    const dir = await fixtureApp({
      'apps/web/api/index.ts': `import { defineApi } from '@ultimat3/action';
export const api = defineApi({});
`,
      'apps/web/app/clock/service.ts': service('probeInProcessClock'),
      'apps/web/shared/ui/card.tsx': 'export const Card = () => null;\n',
      'apps/web/app/widgets/registry.ts': service(
        'probeInProcessWidgets',
        "import { Card } from '../../shared/ui/card.tsx';\nexport const card = Card;\n",
      ),
    });
    expect(await probeRoleLoad(dir)).toEqual([
      {
        kind: 'service',
        name: 'probeInProcessWidgets',
        module: 'apps/web/app/widgets/registry.ts',
      },
    ]);
  }, 60_000);
});
