// What `x g invite` leaves on disk, held to the app's own first run: a fresh `x new` scaffold, the
// generator run through the CLI, then the whole tree compiled by the real `tsc`, the auth slice
// checked by the app's own Biome and its generated tests run under the app's own preload — the
// grant, the API listing and the exercise entries included, which the pure fixture never sees.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm, unlink } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { writeNewApp } from './cmd-new';
import { dispatch } from './dispatch';
import { exec } from './exec';
import { linkWorkspace } from './generate-sign-in-fixture';
import { formatDiagnostics, typecheckScaffold, workspaceRoot } from './scaffold-typecheck-fixture';
import type { GeneratedFile } from './templates';

const APP = 'probe';
const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** A scaffold with `x g invite` run in it, read back as the files on disk. */
async function invited(): Promise<readonly GeneratedFile[]> {
  const root = await mkdtemp(join(tmpdir(), 'x-invite-contract-'));
  made.push(root);
  await writeNewApp(root, { name: APP, example: true });
  const out: string[] = [];
  const code = await dispatch({
    argv: ['g', 'invite', '--json'],
    cwd: root,
    env: {},
    bunVersion: Bun.version,
    write: (line) => out.push(line),
  });
  expect({ code, out: out.join('\n') }).toMatchObject({ code: 0 });
  const files: GeneratedFile[] = [];
  for await (const path of new Bun.Glob('**/*').scan({ cwd: root, dot: true })) {
    files.push({ path, contents: await Bun.file(join(root, path)).bytes() });
  }
  return files;
}

const text = (files: readonly GeneratedFile[], path: string): string =>
  new TextDecoder().decode(
    (files.find((file) => file.path === path)?.contents as Uint8Array | undefined) ??
      new Uint8Array(),
  );

describe('contract · x g invite passes the app own first run', () => {
  test('compiles, lints, grants its permission and its generated tests pass', async () => {
    const files = await invited();
    // The follow-ups: the permission reaches a role, every action is turned off in the pass.
    expect(text(files, 'apps/web/shared/roles.ts')).toContain("'member:invite'");
    // The invite mails, and `x new` declares no mail: the root manifest gains it.
    expect(text(files, 'package.json')).toContain('"@ultimat3/mail"');
    const exercise = text(files, 'apps/web/exercise.ts');
    for (const action of ['inviteMember', 'acceptInvite', 'revokeInvite']) {
      expect(exercise).toContain(`${action}: { off:`);
    }

    const report = await typecheckScaffold({ files, app: APP, keep: true });
    made.push(report.dir);
    expect(formatDiagnostics(report.diagnostics)).toBe('');

    const biome = await exec(
      [join(workspaceRoot(), 'node_modules/.bin/biome'), 'check', 'apps/web', 'app.config.ts'],
      { cwd: report.dir },
    );
    expect(`${biome.stdout}${biome.stderr}`).not.toContain('×');

    // The compile borrowed the checkout's root `node_modules` whole; running needs the packages.
    await unlink(join(report.dir, 'node_modules'));
    await linkWorkspace(report.dir);
    const tests = await exec([process.execPath, 'test', 'apps/web/app/auth'], {
      cwd: report.dir,
      env: { NODE_ENV: 'test' },
    });
    const ran = `${tests.stdout}\n${tests.stderr}`;
    expect(ran).toMatch(/\b0 fail\b/);
    // Every generated test file ran: a filter that matched nothing would pass on zero.
    expect(ran).toMatch(/\b(1\d|[2-9]\d) pass\b/);
    expect(tests.code).toBe(0);
  }, 240_000);
});
