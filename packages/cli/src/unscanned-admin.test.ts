// The reference app's admin lived in `apps/admin/src/index.ts` — outside every glob the app scan
// imports — so `defineAdmin` never ran, `/admin` was never mounted, and nothing said so.

import { afterEach, describe, expect, test } from 'bun:test';
// why: `node:` and not Bun: Bun has no API for a temporary directory (`mkdtempSync` + `tmpdir`) and
// none for a recursive delete (`rmSync`).
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { loadApp, resetAppLoad } from './app-load';
import { unscannedAdminFindings } from './unscanned-admin';

const DECLARATION =
  "import { defineAdmin } from '@ultimat3/admin';\nexport const admin = defineAdmin({ entities: [] });\n";

let root = '';
const app = async (files: Readonly<Record<string, string>>): Promise<string> => {
  root = mkdtempSync(join(tmpdir(), 'x-unscanned-admin-'));
  for (const [path, contents] of Object.entries(files)) await Bun.write(join(root, path), contents);
  return root;
};
const notMounted = (): boolean => false;

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('unit · an admin declared where the scan never looks', () => {
  test('defineAdmin under apps/admin/src is X_ADMIN_UNSCANNED, with the move that mounts it', async () => {
    const findings = await unscannedAdminFindings(
      await app({ 'apps/admin/src/index.ts': DECLARATION }),
      notMounted,
    );
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_ADMIN_UNSCANNED', 'apps/admin/src/index.ts'],
    ]);
    expect(findings[0]?.fix).toBe(
      'git mv apps/admin/src/index.ts apps/admin/app/admin/admin.ts   # then repoint its relative imports and x verify --only manifest --json',
    );
  });

  test('a declaration in the scanned home is no finding; nor is a file that only mentions it', async () => {
    const findings = await unscannedAdminFindings(
      await app({
        'apps/admin/app/admin/admin.ts': DECLARATION,
        'apps/admin/src/notes.ts': '// defineAdmin lives in app/admin\nexport const x = 1;\n',
        'apps/admin/src/admin.test.ts': DECLARATION,
      }),
      notMounted,
    );
    expect(findings).toEqual([]);
  });

  test('an admin that IS mounted reads no file at all', async () => {
    const findings = await unscannedAdminFindings(
      await app({ 'apps/admin/src/index.ts': DECLARATION }),
      () => true,
    );
    expect(findings).toEqual([]);
  });

  test('loadApp reports it, so the `manifest` step does', async () => {
    const loaded = await loadApp(await app({ 'apps/admin/src/index.ts': DECLARATION }));
    resetAppLoad();
    expect(loaded.findings.map((finding) => finding.code)).toContain('X_ADMIN_UNSCANNED');
  });
});
