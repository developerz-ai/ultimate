// `x repro --bundle`: what leaves the machine. A scratch app with a planted secret in every place one
// hides — the input, a read row, a step output, the error's cause and stack, the env, a dotenv file,
// app.config.ts — and each test greps the written bundle for the planted value. Red means a leak.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { FailureBundle } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import type { JobFailure } from '@ultimat3/testing';
import { reproCommand } from './cmd-repro';
import type { CommandContext } from './command';
import type { Runner } from './exec';
import { parseArgs } from './parse';
import { subjectFromFile } from './repro-bundle';

const root = await mkdtemp(join(tmpdir(), 'x-repro-bundle-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const HOME = '/home/planted-user';
const SECRET = 'sk_live_PLANTED0123456789';
const DOTENV_SECRET = 'smtp-pw-PLANTED-42';
const DB_HOST = 'db.planted-internal.test';
const CONFIG_HOST = 'shop.planted-origin.test';
const UNRELATED = 'UNRELATED-ROW-PLANTED';

await Bun.write(
  join(root, 'app.config.ts'),
  `export const config = { origin: 'https://${CONFIG_HOST}' };\n`,
);
await Bun.write(join(root, 'package.json'), '{ "name": "scratch", "version": "0.0.0" }\n');
await Bun.write(join(root, '.env.local'), `SMTP_PASS=${DOTENV_SECRET}\n`);
// A seed nothing in the failing call read: it must not ride along.
await Bun.write(join(root, 'packages/db/seeds/users.json'), JSON.stringify([{ name: UNRELATED }]));
await Bun.write(
  join(root, 'node_modules/@ultimat3/core/package.json'),
  '{ "name": "@ultimat3/core", "version": "31.27.0" }\n',
);

const ENV = {
  HOME,
  STRIPE_KEY: SECRET,
  DATABASE_URL: `postgres://app:pw@${DB_HOST}:5432/app`,
};

const BUNDLE: FailureBundle = {
  id: 'bundle-1',
  fingerprint: 'fp-1',
  code: 'X_PLANTED',
  operation: null,
  primitive: 'action',
  name: 'createPost',
  at: 0,
  requestId: 'req-1',
  traceId: null,
  build: 'b-1',
  input: {
    title: `see ${root}/apps/web/api/posts.ts and ${HOME}/notes.txt`,
    password: 'hunter2-PLANTED',
    note: `paid with ${SECRET} via https://${CONFIG_HOST}/pay and ${DOTENV_SECRET}`,
  },
  masked: [],
  actor: null,
  flags: {},
  reads: [
    { entity: 'post', row: { id: 'p1', apiToken: 'tok-PLANTED-9' }, masked: [] },
    { entity: 'ghost', row: { id: 'g1', name: UNRELATED }, masked: [] },
  ],
  truncated: false,
};

const STACK = [
  `X_PLANTED: could not reach ${DB_HOST} with ${SECRET}`,
  `    at handle (${root}/apps/web/api/posts.ts:12:5)`,
  `    at invoke (${root}/node_modules/@ultimat3/action/src/invoke.ts:88:11)`,
  `    at run (file://${HOME}/.bun/install/cache/x/index.js:3:1)`,
  '    at native (/usr/lib/bun/internal.js:1:1)',
].join('\n');

const FAILURE: JobFailure = {
  jobId: '00000000-0000-4000-8000-0000000000bb',
  name: 'charge',
  input: { card: { token: 'card-tok-PLANTED' }, memo: SECRET },
  masked: [],
  steps: [{ name: 'fetch', output: { secret: 'step-secret-PLANTED', ok: true } }],
  code: 'X_DECLINED',
  step: 'charge',
};

const REQUEST_FILE = join(root, 'request.json');
const JOB_FILE = join(root, 'job.json');
await Bun.write(
  REQUEST_FILE,
  JSON.stringify({
    data: { bundle: BUNDLE, error: { cause: STACK.split('\n')[0], stack: STACK } },
  }),
);
await Bun.write(JOB_FILE, JSON.stringify(FAILURE));

const runner: Runner = async (command) => ({
  command,
  code: 0,
  durationMs: 1,
  ok: true,
  stdout: '',
  stderr: '',
});

const ctxOf = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(['repro', ...argv], [reproCommand.spec]),
  cwd: root,
  runner,
  env: ENV,
  bunVersion: Bun.version,
});

/** Runs `x repro --from <file> --bundle` and answers the written bundle's text and its path. */
async function bundleOf(file: string): Promise<{ text: string; path: string }> {
  const result = await reproCommand.run(ctxOf(['--from', file, '--bundle']));
  expect(result.ok).toBe(true);
  const data = result.data as { file: string };
  const path = join(root, data.file);
  return { text: await Bun.file(path).text(), path };
}

const request = await bundleOf(REQUEST_FILE);
const job = await bundleOf(JOB_FILE);

describe('x repro --bundle', () => {
  test('bundle: no secret value — by key, by declared env value, in a row and a step output', () => {
    for (const { text } of [request, job]) {
      for (const planted of [
        'hunter2-PLANTED',
        'tok-PLANTED-9',
        'card-tok-PLANTED',
        'step-secret-PLANTED',
        SECRET,
      ]) {
        expect(text).not.toContain(planted);
      }
    }
    expect((JSON.parse(request.text) as { masked: string[] }).masked).toEqual(['password']);
    expect((JSON.parse(job.text) as { masked: string[] }).masked).toEqual([
      'card.token',
      'step:fetch:secret',
    ]);
  });

  test('bundle: no env value — the process env and the app dotenv files alike', () => {
    for (const { text } of [request, job]) {
      expect(text).not.toContain(DOTENV_SECRET);
      expect(text).not.toContain(SECRET);
    }
    const parsed = JSON.parse(request.text) as { scrubbed: { env: string[] } };
    expect(parsed.scrubbed.env).toEqual(['SMTP_PASS', 'STRIPE_KEY']);
  });

  test('bundle: no unrelated row — a seed file, an undeclared entity, nothing beyond the reads', () => {
    expect(request.text).not.toContain(UNRELATED);
    const parsed = JSON.parse(request.text) as {
      subject: FailureBundle;
      dropped: string[];
      schema: { entities: unknown[] };
    };
    expect(parsed.dropped).toEqual(['ghost', 'post']);
    expect(parsed.subject.reads).toEqual([]);
    expect(parsed.subject.truncated).toBe(true);
    expect(parsed.schema.entities).toEqual([]);
  });

  test('bundle: no absolute path and no home directory — frames are relative', () => {
    for (const { text } of [request, job]) {
      expect(text).not.toContain(root);
      expect(text).not.toContain(HOME);
      expect(text).not.toContain('/usr/lib');
      expect(text).not.toContain('file://');
    }
    const parsed = JSON.parse(request.text) as { error: { frames: string[] } };
    expect(parsed.error.frames).toEqual([
      'at handle (./apps/web/api/posts.ts:12:5)',
      'at invoke (./node_modules/@ultimat3/action/src/invoke.ts:88:11)',
      'at run (~/.bun/install/cache/x/index.js:3:1)',
      'at native (<abs>/internal.js:1:1)',
    ]);
  });

  test('bundle: no hostname from config or from an env URL', () => {
    expect(request.text).not.toContain(CONFIG_HOST);
    expect(request.text).not.toContain(DB_HOST);
    expect(request.text).toContain('https://[host]/pay');
  });

  test('bundle: carries the framework version, the code and a reproducer the scratch app runs', () => {
    const parsed = JSON.parse(request.text) as {
      format: string;
      code: string;
      framework: { packages: Record<string, string[]>; bun: string };
      reproducer: { file: string; source: string[] };
    };
    expect(parsed.format).toBe('x-repro-bundle/1');
    expect(parsed.code).toBe('X_PLANTED');
    expect(parsed.framework.packages).toEqual({ '@ultimat3/core': ['31.27.0'] });
    expect(parsed.framework.bun).toBe(Bun.version);
    expect(parsed.reproducer.file).toBe('repro/repro-req1.contract.test.ts');
    expect(parsed.reproducer.source.join('\n')).toContain("import { driver } from '@app/db';");
  });

  test('bundle: deterministic bytes, and `x repro --from` reads it back as the redacted subject', async () => {
    const again = await bundleOf(REQUEST_FILE);
    expect(again.text).toBe(request.text);
    const subject = await subjectFromFile(job.path);
    expect(subject.kind).toBe('job');
  });

  test('bundle: refuses --write and --verify beside it', async () => {
    const code = await reproCommand.run(ctxOf(['--from', JOB_FILE, '--bundle', '--write'])).then(
      () => expect.unreachable('--bundle with --write ran'),
      (error: unknown) => (isUltimateError(error) ? error.code : `not coded: ${String(error)}`),
    );
    expect(code).toBe('X_CLI_BAD_FLAG');
  });
});
