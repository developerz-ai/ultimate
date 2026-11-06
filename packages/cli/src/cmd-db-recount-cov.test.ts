// `x db recount <entity>.<column>`'s refusals, decided from the app's declarations before any
// database is started: no target, a target that is not `<entity>.<column>`, an unknown entity.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { runRecountCommand } from './cmd-db-recount';
import { dbSpec } from './cmd-db-spec';
import type { CommandContext } from './command';
import type { Runner } from './exec';
import { parseArgs } from './parse';

const root = await mkdtemp(join(tmpdir(), 'x-db-recount-'));
afterAll(() => rm(root, { recursive: true, force: true }));
await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
await Bun.write(join(root, 'package.json'), '{ "name": "scratch", "version": "0.0.0" }\n');

const noProcess: Runner = () =>
  Promise.reject(new Error('x db recount spawned a process before refusing'));

const causeOf = (...argv: string[]): Promise<string> =>
  runRecountCommand(
    {
      args: parseArgs(['db', 'recount', ...argv], [dbSpec]),
      cwd: root,
      runner: noProcess,
      // No DATABASE_URL: a refusal that reached the database would start an embedded one.
      env: {},
      bunVersion: Bun.version,
    } satisfies CommandContext,
    root,
  ).then(
    () => expect.unreachable('x db recount answered instead of refusing'),
    (error: unknown) =>
      isUltimateError(error) && error.code === 'X_CLI_BAD_FLAG'
        ? error.cause
        : `not X_CLI_BAD_FLAG: ${String(error)}`,
  );

describe('x db recount refusals', () => {
  test('no target says how to name one', async () => {
    expect(await causeOf()).toBe(
      '--name on "x db recount": "" is missing: name the counter as <entity>.<column>',
    );
  });

  test('a target with no column, or a column path, is not <entity>.<column>', async () => {
    expect(await causeOf('posts')).toContain('"posts" is not <entity>.<column>');
    expect(await causeOf('posts.comments.count')).toContain(
      '"posts.comments.count" is not <entity>.<column>',
    );
  });

  test('an entity the app does not declare is named', async () => {
    expect(await causeOf('ghosts.count')).toContain('"ghosts.count" names no entity "ghosts"');
  });
});
