// `x g sign-in` over an `apps/web/runtime.ts` the author already edited, through the CLI on a real
// `x new` scaffold: the guard is spliced in and every line of theirs kept, the untouched scaffold
// still gets the template's exact bytes, a second run conflicts, and a shape the splice cannot read
// refuses the run with the line to edit.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { writeNewApp } from './cmd-new';
import { dispatch } from './dispatch';
import { RUNTIME_MODULE, RUNTIME_TEST } from './templates/scaffold-runtime-ports';
import {
  OIDC_RUNTIME_ROUTES,
  signInRuntimeSource,
  signInRuntimeTest,
} from './templates/sign-in-runtime';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-sign-in-runtime-'));
  await writeNewApp(root, { name: 'probe', example: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Finding {
  readonly code: string;
  readonly fix: string;
  readonly at: string;
}

const run = async (...argv: string[]): Promise<{ ok: boolean; findings: Finding[] }> => {
  const out: string[] = [];
  await dispatch({
    argv: ['g', 'sign-in', ...argv, '--json'],
    cwd: root,
    env: {},
    bunVersion: Bun.version,
    write: (line) => out.push(line),
  });
  const parsed = JSON.parse(out.join('\n')) as { ok: boolean; findings?: Finding[] };
  return { ok: parsed.ok, findings: parsed.findings ?? [] };
};

const read = (path: string): Promise<string> => Bun.file(join(root, path)).text();
const write = (path: string, text: string): Promise<number> => Bun.write(join(root, path), text);

/** The edit every adopter makes: an app import and a spread into the overrides. */
const editRuntime = async (): Promise<string> => {
  const edited = (await read(RUNTIME_MODULE))
    .replace(
      "import type { RuntimeOverrides } from '@ultimat3/cli/serve';\n",
      "import type { RuntimeOverrides } from '@ultimat3/cli/serve';\nimport { extraPorts } from './extra-ports';\n",
    )
    .replace('export const runtime = {\n', 'export const runtime = {\n  ...extraPorts(Bun.env),\n');
  await write(RUNTIME_MODULE, edited);
  return edited;
};

describe('x g sign-in over an edited runtime.ts', () => {
  test('the untouched scaffold gets the template bytes, as before the splice existed', async () => {
    for (const [flags, routes] of [
      [['--password'], undefined],
      [['--oidc', 'corp'], OIDC_RUNTIME_ROUTES],
    ] as const) {
      await rm(root, { recursive: true, force: true });
      await writeNewApp(root, { name: 'probe', example: true });
      expect((await run(...flags)).findings).toEqual([]);
      expect(await read(RUNTIME_MODULE)).toBe(signInRuntimeSource(routes));
      expect(await read(RUNTIME_TEST)).toBe(signInRuntimeTest(routes));
    }
  });

  test('an edited runtime is spliced, not refused: the guard is in, and theirs is kept', async () => {
    await editRuntime();
    const result = await run('--password');
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    const after = await read(RUNTIME_MODULE);
    expect(after).toContain("import { extraPorts } from './extra-ports';");
    expect(after).toContain("import { assertSignInConfigured } from './app/auth/sign-in-guard';");
    expect(after).toContain(
      'assertSignInConfigured(process.env);\n\nexport const runtime = {\n  ...extraPorts(Bun.env),\n',
    );
  });

  test('OIDC over an edited runtime and test: routes mounted, the test asserts them', async () => {
    await editRuntime();
    await write(RUNTIME_TEST, `${await read(RUNTIME_TEST)}// the author's\n`);
    expect((await run('--oidc', 'corp')).findings).toEqual([]);
    expect(await read(RUNTIME_MODULE)).toContain(
      'export const runtime = {\n  routes: signInRoutes,\n',
    );
    const after = await read(RUNTIME_TEST);
    expect(after).toContain("// the author's\n");
    expect(after).toContain('expect(runtime.routes).toBe(signInRoutes);');
  });

  test('a second run is the conflict it always was, and doubles nothing', async () => {
    await editRuntime();
    expect((await run('--password')).ok).toBe(true);
    const once = await read(RUNTIME_MODULE);
    const again = await run('--password');
    expect(again.ok).toBe(false);
    expect(again.findings.map((finding) => finding.code)).toContain('X_GENERATE_CONFLICT');
    expect(again.findings.map((finding) => finding.at)).toContain(RUNTIME_MODULE);
    // Never `--force`: pasted, it would replace the app's own ports with the template.
    const fix = again.findings.find((finding) => finding.at === RUNTIME_MODULE)?.fix ?? '';
    expect(fix).toStartWith('git diff -- apps/web/runtime.ts');
    expect(fix).not.toContain('--force');
    expect(await read(RUNTIME_MODULE)).toBe(once);
  });

  test('a runtime.ts the splice cannot read refuses the run with the line to edit', async () => {
    const built = `import type { RuntimeOverrides } from '@ultimat3/cli/serve';\n\nconst make = (): RuntimeOverrides => ({});\nexport const runtime = make();\n`;
    await write(RUNTIME_MODULE, built);
    const result = await run('--password');
    expect(result.ok).toBe(false);
    const finding = result.findings.find((each) => each.at === RUNTIME_MODULE);
    expect(finding?.code).toBe('X_GENERATE_CONFLICT');
    expect(finding?.fix).toStartWith(`edit ${RUNTIME_MODULE}:4 — `);
    expect(finding?.fix).toContain('then: x g sign-in --password');
    // Refused whole: nothing of the run landed.
    expect(await Bun.file(join(root, 'apps/web/app/auth/sign-in-guard.ts')).exists()).toBe(false);
    expect(await read(RUNTIME_MODULE)).toBe(built);
  });
});
