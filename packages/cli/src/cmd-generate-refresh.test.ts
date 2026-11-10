// `x g` re-projects `x.manifest.json` after a write by loading the whole app — the one slow step
// of a scaffold, and growing with the app. A run whose files the app scan never imports, and
// which declare no `X_*` code, cannot change a fact the manifest holds, so it loads nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no recursive remove, only a per-file delete.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { resetAppLoad } from './app-load';
import { REQUIRED_BUN } from './app-root';
import { generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import { processRoot } from './process-root-fixture';

// Under `packages/cli/`, for the reason `cmd-generate.test.ts` gives: `@ultimat3/*` resolves.
const ROOT = processRoot(join(import.meta.dir, '..', '.generate-refresh-fixture'));
// A module the app scan cannot import: any run that loads the app answers it as a finding.
const BROKEN = 'apps/web/app/broken.ts';
const COMMITTED = '{"buildId":"already-committed"}\n';

const contextFor = (positionals: readonly string[], dryRun = false): CommandContext => ({
  args: {
    command: 'g',
    subcommand: undefined,
    positionals: [...positionals],
    flags: new Map(dryRun ? [['dry-run', true]] : []),
    json: false,
    help: false,
    passthrough: [],
  },
  cwd: ROOT,
  runner: async () => ({
    command: ['true'],
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
  env: {},
  bunVersion: REQUIRED_BUN,
});

describe('unit · x g loads the app only when the manifest can change', () => {
  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(join(ROOT, 'app.config.ts'), `export const config = { name: 'gen' };\n`);
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'generate-refresh-fixture', version: '1.0.0' }),
    );
    await Bun.write(join(ROOT, BROKEN), `export { nope } from './does-not-exist';\n`);
    await Bun.write(join(ROOT, MANIFEST_FILENAME), COMMITTED);
    resetAppLoad();
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    resetAppLoad();
  });

  test('an island is written without loading the app, and the manifest is left as it was', async () => {
    const result = await generateCommand.run(contextFor(['island', 'glow']));
    // A load would have answered the broken module as a finding.
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    const files = (result.data as { files?: readonly string[] }).files ?? [];
    expect(files.some((file) => file.endsWith('glow.island.tsx'))).toBe(true);
    expect(files).not.toContain(MANIFEST_FILENAME);
    expect(await Bun.file(join(ROOT, MANIFEST_FILENAME)).text()).toBe(COMMITTED);
  });

  test('its dry run names no refresh, the same rule the run follows', async () => {
    const result = await generateCommand.run(contextFor(['island', 'shine'], true));
    expect((result.data as { refreshes?: readonly string[] }).refreshes).toBeUndefined();
  });

  test('a primitive still loads the app, and still refuses a partial load', async () => {
    resetAppLoad();
    const result = await generateCommand.run(contextFor(['policy', 'refresh-probe']));
    expect(result.findings?.map((finding) => finding.at)).toContain(BROKEN);
    expect(await Bun.file(join(ROOT, MANIFEST_FILENAME)).text()).toBe(COMMITTED);
  });
});
