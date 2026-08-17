// `checkSourceDrift`'s injected seam makes its own tests cheap, which leaves ONE link untested by
// them: that the real counter loads an app and reads the registry. This is that link.
//
// Every case runs the counter in a SUBPROCESS. `entity()` registers into a process-wide map with no
// per-entry removal — `clearRegistry()` is all or nothing — so a test that registered here would be
// visible to every other suite sharing this process, and it was: `db-generate.test.ts` asserts the
// generated migration holds exactly its own table. A fresh process is also what a real `x` run is.

import { expect, test } from 'bun:test';
// `node:fs`/`node:os` — Bun has no temp-directory API; `node:path` — no Bun path joiner.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE = join(import.meta.dir, 'app-entities.ts');
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

/**
 * An absolute specifier into this checkout, because the temp app has no `node_modules`: a bare
 * `@ultimat3/entity` would fail to import, `loadApp` would file that as a finding, and the count
 * would be zero — the test passing for exactly the reason it exists to catch.
 */
const ENTITY_MODULE = join(import.meta.dir, '..', '..', 'entity', 'src', 'index.ts');

const appRoot = (): string => mkdtempSync(join(tmpdir(), 'x-entities-'));

/** The count as a real `x` invocation would compute it: one app, one registry, one process. */
async function countInFreshProcess(root: string): Promise<number> {
  const script =
    `const { countDeclaredEntities } = await import(${JSON.stringify(MODULE)});\n` +
    `await Bun.stdout.write(String(await countDeclaredEntities(${JSON.stringify(root)})));\n`;
  // cwd is the repo root so `@ultimat3/entity` resolves through the workspace, exactly as it does
  // for the installed CLI inside an app.
  const proc = Bun.spawn(['bun', '-e', script], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect({ code, stderr: await new Response(proc.stderr).text() }).toMatchObject({ code: 0 });
  return Number(out.trim());
}

test('an entity declared in the app is counted — the registry, not a scan of the source', async () => {
  const root = appRoot();
  try {
    await Bun.write(
      join(root, 'packages', 'db', 'src', 'schema.ts'),
      `import { entity, uuid } from ${JSON.stringify(ENTITY_MODULE)};\n` +
        `export const probe = entity('app_entities_probe', { columns: { id: uuid().primaryKey() } });\n`,
    );
    expect(await countInFreshProcess(root)).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an app that declares nothing counts zero — the --no-example scaffold, exactly', async () => {
  const root = appRoot();
  try {
    await Bun.write(join(root, 'packages', 'db', 'src', 'schema.ts'), 'export {};\n');
    expect(await countInFreshProcess(root)).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A module that will not import is a SHORT count, never a throw: the caller reads a zero as "this
// process could load nothing", and a diagnostic that dies on the app it is diagnosing is useless.
test('a module that throws on import is a finding inside loadApp, not an exception out of here', async () => {
  const root = appRoot();
  try {
    await Bun.write(join(root, 'packages', 'db', 'src', 'boom.ts'), 'throw new Error("boom");\n');
    expect(await countInFreshProcess(root)).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
