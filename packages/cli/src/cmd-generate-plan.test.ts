// `x g`'s planning, in a scaffolded app: `--dry-run` answers with the same plan the real run acts
// on — conflicts, skipped slice modules and API-index bindings included — and a binding the index
// already holds stops the run before a file lands (s1-t5 #7, s1-t5 low).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, mkdir or recursive remove — a throwaway app root is node:fs's.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { apiEntriesFor, insertApiEntries } from './api-registration';
import { API_INDEX, REQUIRED_BUN } from './app-root';
import { generateCommand } from './cmd-generate';
import { writeNewApp } from './cmd-new';
import type { CommandContext } from './command';
import { exec } from './exec';
import type { CommandResult } from './output';

let root = '';

const run = (
  positionals: readonly string[],
  flags: readonly [string, string | boolean][],
): Promise<CommandResult> => {
  const ctx: CommandContext = {
    args: {
      command: 'g',
      subcommand: undefined,
      positionals,
      flags: new Map(flags),
      json: false,
      help: false,
      passthrough: [],
    },
    cwd: root,
    runner: exec,
    env: {},
    bunVersion: REQUIRED_BUN,
  };
  return generateCommand.run(ctx);
};

const filesOf = (result: CommandResult): readonly string[] =>
  (result.data as { readonly files?: readonly string[] }).files ?? [];
const exists = (path: string): Promise<boolean> => Bun.file(join(root, path)).exists();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-generate-plan-'));
  await writeNewApp(root, { name: 'plan', example: false });
  for (const slice of ['post', 'comment']) await mkdir(join(root, 'apps/web/app', slice));
  // `post`'s job, listed the way a real `x g job reindex-post --feature post` lists it.
  const index = join(root, API_INDEX);
  const listed = insertApiEntries(
    await Bun.file(index).text(),
    apiEntriesFor(['apps/web/app/post/jobs/reindex-post.ts']),
  );
  await Bun.write(index, listed.source);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('unit · a job named like one the index already lists', () => {
  test('--dry-run reports the conflict, with a name that runs', async () => {
    const result = await run(
      ['job', 'reindex-post'],
      [
        ['feature', 'comment'],
        ['dry-run', true],
      ],
    );
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_GENERATE_CONFLICT']);
    expect(result.findings?.[0]?.fix).toBe('x g job comment-reindex-post --feature comment');
  });

  test('the real run writes nothing and leaves the index as it was', async () => {
    const before = await Bun.file(join(root, API_INDEX)).text();
    const result = await run(['job', 'reindex-post'], [['feature', 'comment']]);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_GENERATE_CONFLICT']);
    expect(await exists('apps/web/app/comment/jobs/reindex-post.ts')).toBe(false);
    expect(await Bun.file(join(root, API_INDEX)).text()).toBe(before);
  });

  // CodeRabbit PRRT_kwDOTkDHL86okhLh: the feature-prefixed name was never checked, so with it ALSO
  // bound the `fix:` reproduced its own conflict. The suggestion is re-planned until it is free.
  test('a suggested name that is itself bound is skipped for one that runs', async () => {
    const index = join(root, API_INDEX);
    const before = await Bun.file(index).text();
    await Bun.write(
      index,
      insertApiEntries(before, apiEntriesFor(['apps/web/app/x/jobs/comment-reindex-post.ts']))
        .source,
    );
    try {
      const refused = await run(
        ['job', 'reindex-post'],
        [
          ['feature', 'comment'],
          ['dry-run', true],
        ],
      );
      const fix = refused.findings?.[0]?.fix ?? '';
      expect(fix).toBe('x g job reindex-post-job --feature comment');
      const retried = await run(
        ['job', fix.split(' ')[3] ?? ''],
        [
          ['feature', 'comment'],
          ['dry-run', true],
        ],
      );
      expect(retried.findings).toEqual([]);
      expect(retried.ok).toBe(true);
    } finally {
      await Bun.write(index, before);
    }
  });

  test('an action named api is refused the same way', async () => {
    const result = await run(
      ['action', 'api'],
      [
        ['feature', 'post'],
        ['dry-run', true],
      ],
    );
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.cause).toContain('"api"');
    expect(result.findings?.[0]?.fix).toBe('x g action post-api --feature post');
  });
});

describe('unit · --dry-run is the write plan, not the file list', () => {
  // "would write 33" where the real run was X_GENERATE_CONFLICT; slice modules a run skips were
  // listed as writes.
  test('an existing file is the conflict the real run reports, and ok is false', async () => {
    await Bun.write(join(root, 'apps/web/app/post/jobs/notify-post.ts'), 'export {};\n');
    const result = await run(
      ['job', 'notify-post'],
      [
        ['feature', 'post'],
        ['dry-run', true],
      ],
    );
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.at)).toEqual([
      'apps/web/app/post/jobs/notify-post.ts',
    ]);
    expect(filesOf(result)).toEqual([]);
  });

  test('a slice module already on disk is not listed as a write', async () => {
    await Bun.write(join(root, 'apps/web/app/comment/repo.ts'), 'export {};\n');
    const result = await run(
      ['job', 'sweep-comments'],
      [
        ['feature', 'comment'],
        ['dry-run', true],
      ],
    );
    expect(result.ok).toBe(true);
    expect(filesOf(result)).toContain('apps/web/app/comment/jobs/sweep-comments.ts');
    expect(filesOf(result)).not.toContain('apps/web/app/comment/repo.ts');
    expect(await exists('apps/web/app/comment/jobs/sweep-comments.ts')).toBe(false);
  });
});
