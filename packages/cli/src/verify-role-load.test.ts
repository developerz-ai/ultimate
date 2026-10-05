// A registration a worker never makes is a build error. One fixture app, probed in a real child:
// a service declared beside a component the API index does not import is named with its module
// and the import that fixes it; the same service in a module of its own is not a finding.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory, a recursive delete or a symlink.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join, win32 } from 'node:path';
import { defineService } from '@ultimat3/core';
import { exec } from './exec';
import {
  PROBE_MARKER,
  parseProbe,
  registeredSince,
  registrations,
  roleLoadFinding,
  roleLoadFindings,
  specifierFor,
} from './verify-role-load';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

const INDEX = `import { defineApi } from '@ultimat3/action';
export const api = defineApi({});
`;

/** Registers on import, in a module that reaches no document: a worker imports it. */
const CLOCK = `import { defineService } from '@ultimat3/core';
export const clock = defineService('fixtureClock', () => ({ now: () => 1 }));
`;

/** Registers on import, in a module that ALSO imports a component: a worker leaves it out. */
const WIDGETS = `import { defineService } from '@ultimat3/core';
import { Card } from '../../shared/ui/card.tsx';
export const widgets = defineService('fixtureWidgets', () => ({ card: Card }));
`;

async function fixtureApp(extra: Readonly<Record<string, string>>): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-verify-role-load-'));
  symlinkSync(join(import.meta.dir, '..', 'node_modules'), join(root, 'node_modules'));
  const files: Readonly<Record<string, string>> = {
    'apps/web/api/index.ts': INDEX,
    'apps/web/app/clock/service.ts': CLOCK,
    'apps/web/shared/ui/card.tsx': 'export const Card = () => null;\n',
    ...extra,
  };
  for (const [path, source] of Object.entries(files)) await Bun.write(join(root, path), source);
  return root;
}

describe('unit · the gate compares what a worker registers with what the whole app does', () => {
  test('a service declared beside a component, outside the API index, is a finding naming all three', async () => {
    const dir = await fixtureApp({ 'apps/web/app/widgets/registry.ts': WIDGETS });
    expect(await roleLoadFindings(dir, exec)).toEqual([
      roleLoadFinding({
        kind: 'service',
        name: 'fixtureWidgets',
        module: 'apps/web/app/widgets/registry.ts',
      }),
    ]);
  }, 60_000);

  test('the same app with the module imported by the API index is clean', async () => {
    const dir = await fixtureApp({
      'apps/web/app/widgets/registry.ts': WIDGETS,
      'apps/web/api/index.ts': `import '../app/widgets/registry';\n${INDEX}`,
    });
    expect(await roleLoadFindings(dir, exec)).toEqual([]);
  }, 60_000);

  test('a probe that prints no answer is a finding, never a pass', async () => {
    const silent = await roleLoadFindings('/nowhere', async (command) => ({
      command,
      code: 1,
      ok: false,
      stdout: 'a module wrote this\n',
      stderr: 'error: Cannot find module\n',
      durationMs: 1,
    }));
    expect(silent.map((finding) => finding.code)).toEqual(['X_ROLE_LOAD_INCOMPLETE']);
    expect(silent[0]?.cause).toContain(
      'did not complete in a process of its own (exit 1: error: Cannot find module)',
    );
    expect(silent[0]?.fix).toMatch(/^bun \S*verify-role-load-probe\.ts \/nowhere$/);
  });

  test('the finding is the module, the registration and the import that fixes it', () => {
    const finding = roleLoadFinding({
      kind: 'service',
      name: 'billing',
      module: 'apps/web/app/billing/registry.ts',
    });
    expect(finding).toMatchObject({
      code: 'X_ROLE_LOAD_INCOMPLETE',
      at: 'apps/web/app/billing/registry.ts',
      cause:
        'service "billing" is registered by importing apps/web/app/billing/registry.ts, which reaches a component or a stylesheet and which apps/web/api/index.ts does not import — so a worker and a scheduler, which import no document, run without it',
      fix: "edit apps/web/api/index.ts: add import '../app/billing/registry'; — or move the service out of apps/web/app/billing/registry.ts into a module that imports no .tsx and no stylesheet",
    });
  });

  test('the import a Windows run proposes is POSIX, the one a Linux run proposes', () => {
    const module = 'apps/web/app/billing/registry.ts';
    expect(specifierFor(module, win32)).toBe('../app/billing/registry');
    expect(specifierFor(module)).toBe('../app/billing/registry');
  });

  test('registrations reads the registries a job resolves by name, one kind each', () => {
    const before = registrations();
    // Left registered: a reset would drop every service another file in this process declared.
    defineService('verifyRoleLoadProbe', () => ({}));
    expect(registeredSince(before, registrations())).toEqual([
      { kind: 'service', name: 'verifyRoleLoadProbe' },
    ]);
  });

  test('registeredSince is by kind AND name; the probe answer is the last marked line', () => {
    const before = [{ kind: 'service', name: 'a' }];
    const after = [...before, { kind: 'entity', name: 'a' }, { kind: 'service', name: 'b' }];
    expect(registeredSince(before, after)).toEqual(after.slice(1));
    const answer = [{ kind: 'service', name: 'b', module: 'apps/web/app/b.ts' }];
    expect(
      parseProbe(`noise\n${PROBE_MARKER}[]\n${PROBE_MARKER}${JSON.stringify(answer)}\n`),
    ).toEqual(answer);
    expect(parseProbe('noise\n')).toBeUndefined();
    expect(parseProbe(`${PROBE_MARKER}[{"kind":1}]\n`)).toBeUndefined();
  });
});
