// Compiles the command registry into a real single-file executable and runs it. `index.ts`
// re-exports `registry.ts`, so importing `@ultimat3/cli` for `runRole` alone — what a compiled
// `apps/web/server.ts` does — evaluates this module; a version read at its module scope is a
// binary that throws before `main`. Only running the artifact can tell the two apart.
//
//   bun test packages/cli/e2e

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ultimate-cli-boot-e2e-'));
const REGISTRY = join(import.meta.dir, '..', 'src', 'registry.ts');
const LOADER = join(import.meta.dir, '..', 'src', 'version-loader.ts');
const BOOTED = 'BOOTED';

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Compile `source` to a standalone executable, run it, and report what the process did. */
async function compileAndRun(
  name: string,
  source: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const entry = join(dir, `${name}.ts`);
  const out = join(dir, name);
  await Bun.write(entry, source);
  const build = Bun.spawn(['bun', 'build', '--compile', entry, '--outfile', out], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await build.exited).toBe(0);
  const run = Bun.spawn([out], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { code, stdout, stderr };
}

test('a compiled binary evaluates the registry without reading the CLI manifest', async () => {
  const result = await compileAndRun(
    'lazy',
    `import { COMMANDS, cliVersion } from ${JSON.stringify(REGISTRY)};
console.log(${JSON.stringify(BOOTED)}, COMMANDS.length);
try {
  console.log('VERSION', cliVersion());
} catch {
  console.log('UNAVAILABLE');
}
`,
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(BOOTED);
  // Every command still registered — the module ran in full, it was not short-circuited.
  expect(result.stdout.trim().split('\n')[0]).toMatch(/^BOOTED \d+$/);
  // And the manifest really is absent, so booting is laziness rather than luck: `/$bunfs` carries
  // no `package.json`, which is exactly the read an eager `const` performed at import.
  expect(result.stdout).toContain('UNAVAILABLE');
}, 60_000);

test('the same read at module scope kills the binary before it boots', async () => {
  const result = await compileAndRun(
    'eager',
    `import { loadVersion } from ${JSON.stringify(LOADER)};
export const CLI_VERSION = loadVersion();
console.log(${JSON.stringify(BOOTED)}, CLI_VERSION);
`,
  );
  expect(result.code).not.toBe(0);
  expect(result.stdout).not.toContain(BOOTED);
  expect(result.stderr).toContain('package.json');
}, 60_000);
