// Every workspace `x new` writes typechecks the ROOT program. A type extension declared in one
// workspace (`PermissionRegistry` in `apps/web/app/*/policy.ts`) is only in force when its file is
// in the program, and `apps/admin`'s own `tsconfig.json` never includes it: measured on a scratch
// scaffold, `KnownPermission = 'post:raed'` in `apps/admin` was TS2820 at the root and clean under
// `tsc -p apps/admin/tsconfig.json` — a per-workspace run that passes what the gate refuses.

import { expect, test } from 'bun:test';
import { planNewApp } from '../cmd-new';

const ROOT_PROGRAM = 'tsc --noEmit -p ../../tsconfig.json';

test.each([true, false])(
  'every workspace typecheck is the root program (example: %p)',
  (example) => {
    const manifests = planNewApp({ name: 'ledger-demo', example }).filter((file) =>
      /^(apps|packages)\/[^/]+\/package\.json$/.test(file.path),
    );
    expect(manifests.map((file) => file.path)).toContain('apps/admin/package.json');
    const scripts = manifests.map((file) => ({
      path: file.path,
      typecheck: (JSON.parse(String(file.contents)) as { scripts?: Record<string, string> })
        .scripts?.['typecheck'],
    }));
    expect(
      scripts.filter((entry) => entry.typecheck !== undefined && entry.typecheck !== ROOT_PROGRAM),
    ).toEqual([]);
    expect(scripts.find((entry) => entry.path === 'apps/web/package.json')?.typecheck).toBe(
      ROOT_PROGRAM,
    );
  },
);
