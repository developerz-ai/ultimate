// The `gh` seam, driven with a reply table: no network, no `gh` on PATH, and every argv this CLI
// will ever send to GitHub asserted byte for byte. The four refusals are here too, because "gh is
// missing" and "gh is not logged in" have different remedies and used to have neither.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { ExecResult, Runner } from './exec';
import { ghDetail, ghGraphql, ghJson, runGh } from './gh';
import { currentBranch, resolvePrNumber, resolveRepo } from './gh-target';

interface Reply {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** A runner that records and answers from a table. A call it has no answer for is the failure. */
function recorder(answer: (command: readonly string[]) => Reply | undefined): {
  runner: Runner;
  ran: string[][];
} {
  const ran: string[][] = [];
  const runner: Runner = async (command): Promise<ExecResult> => {
    ran.push([...command]);
    const reply = answer(command);
    if (reply === undefined) expect.unreachable(`no reply for: ${command.join(' ')}`);
    const code = reply.code ?? 0;
    return {
      command,
      code,
      ok: code === 0,
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      durationMs: 1,
    };
  };
  return { runner, ran };
}

const host = (answer: (command: readonly string[]) => Reply | undefined) => {
  const { runner, ran } = recorder(answer);
  return { host: { runner, cwd: '/repo' }, ran };
};

const caught = async (
  work: Promise<unknown>,
): Promise<{ code?: string; fix?: string; cause?: string }> =>
  work.then(
    () => ({}),
    (error: unknown) => error as { code?: string; fix?: string; cause?: string },
  );

const OPTIONS = { label: 'gh probe', fix: 'x ci --json' };

describe('unit · the gh seam spawns gh and nothing else', () => {
  test('the binary is prepended and the host cwd is the working directory', async () => {
    const { host: h, ran } = host(() => ({ stdout: 'ok' }));
    const result = await runGh(h, ['repo', 'view'], OPTIONS);
    expect(ran).toEqual([['gh', 'repo', 'view']]);
    expect(result.stdout).toBe('ok');
  });

  // `exec.ts` raises for a program that is not on PATH. That refusal names the binary and offers
  // `x doctor`, which knows nothing about GitHub credentials — so it is remapped, once, here.
  test('a spawn failure is X_GH_UNAVAILABLE, and the fix installs gh', async () => {
    const h = {
      cwd: '/repo',
      runner: (): Promise<ExecResult> =>
        Promise.reject(
          new UltimateError({ code: 'X_CLI_UNEXPECTED', cause: 'ENOENT', fix: 'x doctor' }),
        ),
    };
    const error = await caught(runGh(h, ['repo', 'view'], OPTIONS));
    expect(error.code).toBe('X_GH_UNAVAILABLE');
    expect(error.fix).toContain('gh auth login');
    expect(error.cause).toContain('/repo');
  });

  test('every spelling of "no credentials" is X_GH_NOT_AUTHENTICATED, fixed by one command', async () => {
    for (const stderr of [
      'gh: You are not logged into any GitHub hosts. To log in, run: gh auth login',
      'gh: HTTP 401: Bad credentials',
      'gh: To use GitHub CLI in a workflow, set the GH_TOKEN environment variable',
    ]) {
      const { host: h } = host(() => ({ code: 1, stderr }));
      const error = await caught(runGh(h, ['pr', 'view'], OPTIONS));
      expect([stderr, error.code]).toEqual([stderr, 'X_GH_NOT_AUTHENTICATED']);
      expect([stderr, error.fix]).toEqual([stderr, 'gh auth login']);
    }
  });

  // The two must not collapse: an unknown thread id and a missing token both exit 1, and telling
  // an agent to run `gh auth login` for a typo is a fix that cannot close the error.
  test('any other non-zero exit is X_GH_COMMAND_FAILED and keeps the caller own fix', async () => {
    const { host: h } = host(() => ({ code: 1, stderr: 'gh: Could not resolve to a node' }));
    const error = await caught(runGh(h, ['api', 'graphql'], OPTIONS));
    expect(error.code).toBe('X_GH_COMMAND_FAILED');
    expect(error.fix).toBe('x ci --json');
    expect(error.cause).toBe('gh probe exited 1: Could not resolve to a node');
  });

  test('the detail is the first line, unprefixed and bounded', () => {
    const result = (stdout: string, stderr: string): ExecResult => ({
      command: ['gh'],
      code: 1,
      ok: false,
      stdout,
      stderr,
      durationMs: 1,
    });
    expect(ghDetail(result('', 'gh: nope\nsecond line'))).toBe('nope');
    expect(ghDetail(result('body', '')).length).toBe(4);
    expect(ghDetail(result('', `gh: ${'x'.repeat(400)}`))).toHaveLength(201);
  });
});

const SHAPE = t.object({ nameWithOwner: t.string });

describe('unit · a gh response is parsed, never cast', () => {
  test('valid JSON of the declared shape comes back typed', async () => {
    const { host: h } = host(() => ({ stdout: '{"nameWithOwner":"developerz-ai/ultimate"}' }));
    expect((await ghJson(h, ['repo', 'view'], SHAPE, OPTIONS)).nameWithOwner).toBe(
      'developerz-ai/ultimate',
    );
  });

  test('output that is not JSON is X_GH_RESPONSE_INVALID, not a TypeError two frames later', async () => {
    const { host: h } = host(() => ({ stdout: '<html>proxy</html>' }));
    const error = await caught(ghJson(h, ['repo', 'view'], SHAPE, OPTIONS));
    expect(error.code).toBe('X_GH_RESPONSE_INVALID');
    expect(error.fix).toBe('x ci --json');
  });

  test('JSON of the wrong shape names the field that did not match', async () => {
    const { host: h } = host(() => ({ stdout: '{"nameWithOwner":42}' }));
    const error = await caught(ghJson(h, ['repo', 'view'], SHAPE, OPTIONS));
    expect(error.code).toBe('X_GH_RESPONSE_INVALID');
    expect(error.cause).toContain('nameWithOwner');
  });
});

describe('unit · graphql variables ride on the flag their TYPE requires', () => {
  test('the document is one -f query=, a string is -f, and a number is -F', async () => {
    const { host: h, ran } = host(() => ({ stdout: '{"nameWithOwner":"a/b"}' }));
    await ghGraphql(h, 'query($n:Int!){x}', { owner: 'developerz-ai', n: 238 }, SHAPE, OPTIONS);
    expect(ran[0]).toEqual([
      'gh',
      'api',
      'graphql',
      '-f',
      'query=query($n:Int!){x}',
      '-f',
      'owner=developerz-ai',
      '-F',
      'n=238',
    ]);
  });

  // `-F body=@notes.md` makes gh read a LOCAL FILE and post its contents. A reply body is the one
  // value a user writes freely, so it must never reach the typed flag.
  test('a body beginning with @ still rides as -f, so gh cannot read it off disk', async () => {
    const { host: h, ran } = host(() => ({ stdout: '{"nameWithOwner":"a/b"}' }));
    await ghGraphql(h, 'mutation{x}', { b: '@/etc/passwd' }, SHAPE, OPTIONS);
    expect(ran[0]).toContain('-f');
    expect(ran[0]).not.toContain('-F');
    expect(ran[0]?.at(-1)).toBe('b=@/etc/passwd');
  });
});

describe('unit · which repository, which pull request, which branch', () => {
  test('a malformed --repo is refused before anything is spawned', async () => {
    const { host: h, ran } = host(() => undefined);
    const error = await caught(resolveRepo(h, 'pr', 'ultimate'));
    expect(error.code).toBe('X_CLI_BAD_FLAG');
    expect(ran).toEqual([]);
  });

  test('with no --repo, gh repo view answers, and the slug is split once', async () => {
    const { host: h, ran } = host(() => ({ stdout: '{"nameWithOwner":"developerz-ai/ultimate"}' }));
    expect(await resolveRepo(h, 'pr', undefined)).toEqual({
      owner: 'developerz-ai',
      name: 'ultimate',
      slug: 'developerz-ai/ultimate',
    });
    expect(ran[0]).toEqual(['gh', 'repo', 'view', '--json', 'nameWithOwner']);
  });

  test('no pull request for this checkout is X_PR_NOT_FOUND, with a number to pass instead', async () => {
    const { host: h } = host(() => ({
      code: 1,
      stderr: 'gh: no pull requests found for branch "x"',
    }));
    const error = await caught(resolvePrNumber(h, { owner: 'a', name: 'b', slug: 'a/b' }));
    expect(error.code).toBe('X_PR_NOT_FOUND');
    expect(error.fix).toContain('x pr review --pr');
  });

  test('the branch comes from git, and a git that refuses is coded rather than empty', async () => {
    const { host: ok, ran } = host(() => ({ stdout: 'feat/agent-observability\n' }));
    expect(await currentBranch(ok)).toBe('feat/agent-observability');
    expect(ran[0]).toEqual(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
    const { host: bad } = host(() => ({ code: 128, stderr: 'fatal: not a git repository' }));
    const error = await caught(currentBranch(bad));
    expect(error.code).toBe('X_GH_COMMAND_FAILED');
    expect(error.cause).toContain('not a git repository');
  });
});
