import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { nestedAppRootFindings } from './verify-drift-owner';

const root = mkdtempSync(join(tmpdir(), 'drift-owner-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('unit · one repository is one app: one image, one migration owner', () => {
  test('a repository whose only app.config.ts is at the root finds nothing', async () => {
    await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
    await Bun.write(join(root, 'apps/api/app/status/status.ts'), 'export const a = 1;\n');
    // A dependency's own config is not this app's: node_modules is never read.
    await Bun.write(join(root, 'node_modules/x/app.config.ts'), 'export const config = {};\n');
    expect(await nestedAppRootFindings(root)).toEqual([]);
  });

  test('an app.config.ts inside a workspace is X_APP_ROOT_NESTED, at that file', async () => {
    await Bun.write(join(root, 'apps/api/app.config.ts'), 'export const config = {};\n');
    await Bun.write(join(root, 'packages/billing/app.config.ts'), 'export const config = {};\n');
    const findings = await nestedAppRootFindings(root);
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_APP_ROOT_NESTED', 'apps/api/app.config.ts'],
      ['X_APP_ROOT_NESTED', 'packages/billing/app.config.ts'],
    ]);
    expect(findings[0]?.cause).toContain('apps/api');
    expect(findings[0]?.fix).toBe(
      'x verify --only drift --json   # after deleting apps/api/app.config.ts and moving what it configured into the root app.config.ts',
    );
  });
});
