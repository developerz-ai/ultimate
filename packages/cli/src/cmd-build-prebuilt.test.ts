// `x build --target prebuilt` and the docker target's half of the same contract: the store a
// container boots from is written INSIDE the image build, in process, and never on the host.

import { expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no recursive remove, no sync exists and no directory listing.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { setSassCacheDir } from '@ultimat3/render/server';
import { REQUIRED_BUN } from './app-root';
import { buildCommand } from './cmd-build';
import type { CommandContext } from './command';
import type { Runner } from './exec';
import { readIslandStore } from './island-store';
import { parseArgs } from './parse';
import { SPECS } from './registry';
import { PREBUILT_DIR, PREBUILT_SASS_DIR } from './serve-prebuilt-paths';
import type { ThrownShape } from './thrown-by-fixture';

/** An app root with the entries the docker and prebuilt targets require. */
async function buildRoot(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-build-prebuilt-'));
  await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await Bun.write(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'build-prebuilt', version: '1.0.0' }),
  );
  await Bun.write(join(dir, 'docker', 'Dockerfile'), 'FROM oven/bun:1.4-alpine\n');
  return dir;
}

/** A runner that records and succeeds: nothing here may reach a real `tsc` or `docker`. */
function scriptedRunner(): { runner: Runner; ran: string[][] } {
  const ran: string[][] = [];
  const runner: Runner = async (command) => {
    ran.push([...command]);
    return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 5 };
  };
  return { runner, ran };
}

const buildContext = (argv: readonly string[], cwd: string, runner: Runner): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd,
  runner,
  env: {},
  bunVersion: REQUIRED_BUN,
});

// The store a container boots from is written INSIDE the image build, by the image's own Bun at
// the image's own paths. Written on the host it sat under `.x/`, which every ignore file drops —
// so no image ever carried one and every web pod built every island on every boot.
test('the docker target writes no island store on the host: the image build does', async () => {
  const dir = await buildRoot();
  try {
    await Bun.write(
      join(dir, 'apps/web/site/plain.island.tsx'),
      "export function mount(el: HTMLElement): void { el.textContent = 'plain'; }\n",
    );
    const { runner } = scriptedRunner();
    const result = await buildCommand.run(
      buildContext(['build', '--no-preflight', '--tag', 'app:ci'], dir, runner),
    );
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, '.x', 'islands'))).toBe(false);
    expect(existsSync(join(dir, PREBUILT_DIR))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('--target prebuilt writes the store in process: no gate, no builder, and a count of each', async () => {
  const dir = await buildRoot();
  try {
    await Bun.write(join(dir, 'apps/web/server.ts'), 'export {};\n');
    await Bun.write(
      join(dir, 'apps/web/site/plain.island.tsx'),
      "export function mount(el: HTMLElement): void { el.textContent = 'plain'; }\n",
    );
    await Bun.write(join(dir, 'apps/web/site/home.scss'), '.home { color: red; }\n');
    await Bun.write(
      join(dir, 'apps/web/site/home.ts'),
      "import './home.scss';\nexport const home = 1;\n",
    );
    const { runner, ran } = scriptedRunner();
    const result = await buildCommand.run(
      buildContext(['build', '--target', 'prebuilt'], dir, runner),
    );
    // No `tsc`, no `biome`, no `docker`: the image holds no devDependencies, and the gate ran
    // before `docker build` was ever called.
    expect(ran).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      target: 'prebuilt',
      artifact: PREBUILT_DIR,
      islands: 1,
      stylesheets: 1,
    });
    expect((await readIslandStore(dir)).stale).toBeUndefined();
    expect(readdirSync(join(dir, PREBUILT_SASS_DIR)).length).toBe(1);
  } finally {
    setSassCacheDir(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('--target prebuilt fails on a module that would not import, naming it', async () => {
  const dir = await buildRoot();
  try {
    await Bun.write(join(dir, 'apps/web/server.ts'), 'export {};\n');
    await Bun.write(
      join(dir, 'apps/web/site/broken.ts'),
      "import './never-written';\nexport const broken = 1;\n",
    );
    const { runner } = scriptedRunner();
    const result = await buildCommand.run(
      buildContext(['build', '--target', 'prebuilt'], dir, runner),
    );
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.at)).toEqual(['apps/web/site/broken.ts']);
  } finally {
    setSassCacheDir(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('--tag and --out on the prebuilt target are refused: the boot reads one fixed place', async () => {
  const dir = await buildRoot();
  try {
    await Bun.write(join(dir, 'apps/web/server.ts'), 'export {};\n');
    const { runner } = scriptedRunner();
    for (const flag of ['tag', 'out']) {
      const thrown = (await buildCommand
        .run(buildContext(['build', '--target', 'prebuilt', `--${flag}`, 'x'], dir, runner))
        .then(
          () => expect.unreachable('expected a throw'),
          (error: unknown) => error,
        )) as ThrownShape;
      expect(thrown.code).toBe('X_CLI_BAD_FLAG');
      expect(thrown.fix).toBe('x build --target prebuilt');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
