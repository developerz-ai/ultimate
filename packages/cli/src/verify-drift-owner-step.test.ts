// The `drift` step itself, not the helper: a nested `app.config.ts` reds the gate step that owns
// migrations, so "one repository is one app" is a build error, not a sentence in the wiki.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { exec } from './exec';
import { VERIFY_STEPS } from './verify-checks';

const root = mkdtempSync(join(tmpdir(), 'drift-owner-step-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const drift = VERIFY_STEPS.find((step) => step.name === 'drift');

describe('unit · the drift step refuses a second app root', () => {
  test('apps/api/app.config.ts is X_APP_ROOT_NESTED on the drift step', async () => {
    await Bun.write(
      join(root, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\nexport const config = defineConfig({ name: 'probe' });\n",
    );
    await Bun.write(join(root, 'apps/api/app.config.ts'), 'export const config = {};\n');
    if (drift === undefined) return expect.unreachable('no drift step');
    const outcome = await drift.run({ root, runner: exec });
    expect(outcome.ok).toBe(false);
    expect(outcome.findings.map((finding) => [finding.code, finding.at])).toContainEqual([
      'X_APP_ROOT_NESTED',
      'apps/api/app.config.ts',
    ]);
  }, 60_000);
});
