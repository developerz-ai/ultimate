// The commands that write through their own boot, beside an `x dev` holding the embedded database:
// each would be a second PGlite writer, whose rows the holder's next write replaces without an
// error on either side. Refused before `.x/pgdata` is opened, with the fix that works.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import type { CommandContext } from './command';
import { lockPath } from './dev-lock';
import { exec } from './exec';
import { parseArgs } from './parse';
import { commandFor, SPECS } from './registry';

/** The package under test, by path: a temp directory outside the repo resolves no workspace. */
const ENTITY = join(import.meta.dir, '..', '..', 'entity', 'src', 'index.ts');
const SEED = `import { defineSeed } from ${JSON.stringify(ENTITY)};
export const dev = defineSeed('dev', async () => {}, { tier: 'dev' });
`;

/** An app root a live `x dev` (this process's pid) holds; `env` decides which database it is. */
async function held<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'x-embedded-write-'));
  try {
    await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'held' };\n");
    await Bun.write(join(root, 'packages/db/seeds/dev.ts'), SEED);
    const lock = { pid: process.pid, port: 1, url: 'http://localhost:1', startedAt: '' };
    await Bun.write(lockPath(join(root, '.x')), JSON.stringify(lock));
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function refusalOf(argv: readonly string[]): Promise<{ code: string; fix: string }> {
  return held(async (root) => {
    const ctx: CommandContext = {
      args: parseArgs(argv, SPECS),
      cwd: root,
      runner: exec,
      env: {},
      bunVersion: REQUIRED_BUN,
    };
    const command = commandFor(argv[0] ?? '') ?? expect.unreachable('no such command');
    const error = await command.run(ctx).then(
      () => expect.unreachable(`x ${argv.join(' ')} ran beside a live embedded x dev`),
      (thrown: unknown) => thrown,
    );
    if (!isUltimateError(error)) return expect.unreachable('an uncoded throw');
    expect(await Bun.file(join(root, '.x/pgdata/PG_VERSION')).exists()).toBe(false);
    return { code: error.code, fix: error.fix };
  });
}

const TAIL = '   # the embedded database takes one process at a time; pass the flags you passed';

describe('unit · a second embedded writer beside x dev is refused with the fix that works', () => {
  test.each([
    [['db', 'backfill', 'fill-slugs', '--write'], 'x db backfill fill-slugs --write'],
    [['db', 'seed', 'dev'], 'x db seed dev'],
    [['db', 'seed', '--generate'], 'x db seed --generate'],
    [['jobs', 'pause', 'default'], 'x jobs pause default'],
    [['jobs', 'retry', 'job_1'], 'x jobs retry job_1'],
    [['auth', 'seal-mfa'], 'x auth seal-mfa'],
  ])('x %j', async (argv, resumed) => {
    expect(await refusalOf(argv)).toEqual({
      code: 'X_DEV_ALREADY_RUNNING',
      fix: `x stop --json && ${resumed} && x dev${TAIL}`,
    });
  });
});
