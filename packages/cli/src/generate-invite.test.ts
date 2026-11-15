// `x g invite`, run against a real `x new` scaffold: it writes its listed files and the edits beside
// them, a dry run lists exactly what a run writes, a second run refuses and writes nothing, and the
// spelling takes no name and no flag it would ignore.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { writeNewApp } from './cmd-new';
import { dispatch } from './dispatch';
import { generate } from './generate-files';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-invite-'));
  await writeNewApp(root, { name: 'probe', example: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = async (...argv: string[]) => {
  const out: string[] = [];
  const code = await dispatch({
    argv: [...argv, '--json'],
    cwd: root,
    env: {},
    bunVersion: Bun.version,
    write: (line) => out.push(line),
  });
  const parsed = JSON.parse(out.join('\n')) as {
    ok: boolean;
    data?: { files?: string[] };
    findings?: { code: string }[];
    error?: { code: string };
  };
  return {
    code,
    files: parsed.data?.files ?? [],
    codes: [
      ...(parsed.findings ?? []).map((finding) => finding.code),
      ...(parsed.error === undefined ? [] : [parsed.error.code]),
    ],
  };
};

const ACTIONS = ['invite-member', 'accept-invite', 'revoke-invite'];

describe('unit · x g invite', () => {
  test('the planner writes the flow, its policy, three tested actions and two tested pages', () => {
    const paths = generate({ kind: 'invite', name: 'invite' }).map((file) => file.path);
    for (const action of ACTIONS) {
      expect(paths).toContain(`apps/web/app/auth/actions/${action}.ts`);
      expect(paths).toContain(`apps/web/app/auth/actions/${action}.test.ts`);
    }
    for (const path of [
      'apps/web/app/auth/invite.ts',
      'apps/web/app/auth/policy.ts',
      'apps/web/app/auth/invites/page.tsx',
      'apps/web/app/auth/invites/accept/page.tsx',
    ]) {
      expect(paths).toContain(path);
    }
  });

  test('a run grants the permission, declares mail and turns each action off in the pass', async () => {
    const planned = await run('g', 'invite', '--dry-run');
    const ran = await run('g', 'invite');
    expect(ran.code).toBe(0);
    expect(ran.codes).toEqual([]);
    expect(ran.files).toEqual(expect.arrayContaining(planned.files));
    expect(ran.files).toEqual(
      expect.arrayContaining(['package.json', 'apps/web/shared/roles.ts', 'apps/web/exercise.ts']),
    );
    expect(await Bun.file(join(root, 'package.json')).text()).toContain('"@ultimat3/mail"');
    expect(await Bun.file(join(root, 'apps/web/shared/roles.ts')).text()).toContain(
      "'member:invite'",
    );
    const exercise = await Bun.file(join(root, 'apps/web/exercise.ts')).text();
    for (const name of ['inviteMember', 'acceptInvite', 'revokeInvite']) {
      expect(exercise).toContain(`${name}: { off:`);
    }
  });

  test('a second run is a conflict and writes nothing', async () => {
    await run('g', 'invite');
    const again = await run('g', 'invite');
    expect(again.code).not.toBe(0);
    expect(again.codes).toContain('X_GENERATE_CONFLICT');
    expect(again.files).toEqual([]);
  });

  test('a name or an ignored flag is refused before anything is written', async () => {
    const named = await run('g', 'invite', 'team');
    expect(named.codes).toEqual(['X_CLI_BAD_FLAG']);
    const flagged = await run('g', 'invite', '--feature', 'orgs');
    expect(flagged.codes).toEqual(['X_CLI_BAD_FLAG']);
    expect(await Bun.file(join(root, 'apps/web/app/auth/invite.ts')).exists()).toBe(false);
  });
});
