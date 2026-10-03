// `x build`'s flags against its targets: a flag the chosen target never reads is refused before the
// gate runs, never dropped. `--tag` on `binary` and `--out` on `docker` used to parse, change
// nothing and print a green build — an agent then believes the artifact landed where it asked.

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { buildCommand } from './cmd-build';
import type { Runner } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

async function appRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-build-flags-'));
  await Bun.write(join(dir, 'app.config.ts'), 'export const config = {};\n');
  await Bun.write(join(dir, 'package.json'), JSON.stringify({ name: 'flags', version: '1.0.0' }));
  await Bun.write(join(dir, 'docker', 'Dockerfile'), 'FROM oven/bun:1.3-alpine\n');
  await Bun.write(join(dir, 'apps/web/server.ts'), 'export {};\n');
  await Bun.write(join(dir, 'apps/web/prerender.ts'), 'export {};\n');
  return dir;
}

const refusal = async (argv: readonly string[]) => {
  const dir = await appRoot();
  const ran: string[][] = [];
  const runner: Runner = async (command) => {
    ran.push([...command]);
    return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 1 };
  };
  try {
    const thrown = await buildCommand
      .run({ args: parseArgs(argv, SPECS), cwd: dir, runner, env: {}, bunVersion: REQUIRED_BUN })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    return { thrown, ran };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test.each([
  ['docker', 'out', ['--out', 'dist']],
  ['binary', 'tag', ['--tag', 'app:1']],
  ['static', 'tag', ['--tag', 'app:1']],
  ['prebuilt', 'tag', ['--tag', 'app:1']],
  ['prebuilt', 'out', ['--out', 'dist']],
  ['prebuilt', 'preflight', ['--no-preflight']],
])('--target %s refuses --%s before anything is spawned', async (target, flag, extra) => {
  const { thrown, ran } = await refusal(['build', '--target', target, ...extra]);
  expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
  expect((thrown as { cause: string }).cause).toContain(`--${flag}`);
  expect((thrown as { fix: string }).fix).toBe(`x build --target ${target}`);
  expect(ran).toEqual([]);
});

test('a flag the target reads is not refused', async () => {
  const { thrown } = await refusal(['build', '--target', 'docker', '--tag', 'app:1']);
  expect(thrown).toBeUndefined();
}, 60_000);
