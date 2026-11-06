// `x client customer` in a scratch app, called through the command itself (no dispatcher): the
// committed `openapi.json` compiled into `types.ts` + `index.ts` (+ `package.json` on
// `--package`), the stamp a regeneration reads, `--only`, and the two refusals before any write.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { readStamp } from './client-emit-header';
import { clientCommand } from './cmd-client';
import type { CommandContext } from './command';
import type { Runner } from './exec';
import { parseArgs } from './parse';

const root = await mkdtemp(join(tmpdir(), 'x-client-customer-'));
afterAll(() => rm(root, { recursive: true, force: true }));
await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
await Bun.write(join(root, 'package.json'), '{ "name": "scratch", "version": "0.0.0" }\n');

const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const DOCUMENT = {
  openapi: '3.1.0',
  info: { title: 'Shop', version: '4.2.0' },
  paths: {
    '/orders': {
      get: {
        operationId: 'listOrders',
        tags: ['read'],
        responses: { '200': json({ type: 'array', items: { type: 'string' } }) },
      },
      post: {
        operationId: 'createOrder',
        tags: ['write'],
        responses: { '200': json({ type: 'string' }) },
      },
    },
  },
};

const unreachableRunner: Runner = () =>
  Promise.reject(new Error('x client customer spawned a process; it must only write files'));

const ctxOf = (...argv: string[]): CommandContext => ({
  args: parseArgs(['client', 'customer', ...argv], [clientCommand.spec]),
  cwd: root,
  runner: unreachableRunner,
  env: {},
  bunVersion: Bun.version,
});

const refusal = (ctx: CommandContext): Promise<{ code: string; cause: string }> =>
  clientCommand.run(ctx).then(
    () => expect.unreachable('x client customer answered instead of refusing'),
    (error: unknown) =>
      isUltimateError(error)
        ? { code: error.code, cause: error.cause }
        : { code: `not coded: ${String(error)}`, cause: '' },
  );

describe('x client customer', () => {
  test('without --out it refuses on that flag, before reading anything', async () => {
    const got = await refusal(ctxOf());
    expect(got.code).toBe('X_CLI_BAD_FLAG');
    expect(got.cause).toContain('--out on "x client customer"');
  });

  test('with no committed openapi.json it refuses rather than compiling nothing', async () => {
    const got = await refusal(ctxOf('--out', 'clients/customer'));
    expect(got.code).toBe('X_CLI_BAD_FLAG');
    expect(got.cause).toContain('openapi.json has not been written');
  });

  test('writes both files stamped with the regenerating command, and package.json on --package', async () => {
    await Bun.write(join(root, 'openapi.json'), JSON.stringify(DOCUMENT));
    const result = await clientCommand.run(
      ctxOf('--out', 'clients/customer', '--package', 'shop-client'),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      kind: 'customer',
      dir: 'clients/customer',
      source: 'openapi.json',
      mount: null,
      only: null,
      operations: ['createOrder', 'listOrders'],
      written: [
        'clients/customer/types.ts',
        'clients/customer/index.ts',
        'clients/customer/package.json',
      ],
    });
    const index = await Bun.file(join(root, 'clients/customer/index.ts')).text();
    const stamp = readStamp(index)?.stamp;
    expect(stamp?.command).toBe('x client customer --out clients/customer --package shop-client');
    expect(stamp?.source).toBe('openapi.json');
    expect(index).toContain('listOrders');
    const pkg: unknown = await Bun.file(join(root, 'clients/customer/package.json')).json();
    expect(pkg).toEqual({
      name: 'shop-client',
      version: '4.2.0',
      type: 'module',
      exports: { '.': './index.ts', './types': './types.ts' },
      files: ['index.ts', 'types.ts'],
    });
  });

  test('--only keeps the tagged operations, records them, and writes no package.json unasked', async () => {
    await Bun.write(join(root, 'openapi.json'), JSON.stringify(DOCUMENT));
    const result = await clientCommand.run(ctxOf('--out', 'clients/reader', '--only', 'read'));
    expect(result.data).toMatchObject({ only: ['read'], operations: ['listOrders'] });
    expect(await Bun.file(join(root, 'clients/reader/package.json')).exists()).toBe(false);
    const stamp = readStamp(await Bun.file(join(root, 'clients/reader/types.ts')).text())?.stamp;
    expect(stamp?.command).toBe('x client customer --out clients/reader --only read');
  });
});
