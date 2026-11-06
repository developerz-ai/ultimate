// `x client vendor` through the dispatcher in a scratch app: `--json` on success and on each
// refusal, the committed source, a regeneration with no flags, and the `drift` rail — a hand edit
// is `X_CLIENT_EDITED`, a moved source is `X_CLIENT_STALE`, and both clear on regeneration.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { checkClientDrift } from './client-emit-drift';
import { dispatch } from './dispatch';

const root = await mkdtemp(join(tmpdir(), 'x-client-cmd-'));
afterAll(() => rm(root, { recursive: true, force: true }));
await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
await Bun.write(join(root, 'package.json'), '{ "name": "scratch", "version": "0.0.0" }\n');

const vendorDoc = (field: string): unknown => ({
  openapi: '3.1.0',
  info: { title: 'Weather', version: '1' },
  paths: {
    '/forecast': {
      get: {
        operationId: 'forecast',
        tags: ['read'],
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { [field]: { type: 'number' } } },
              },
            },
          },
        },
      },
    },
    '/alerts': {
      get: {
        operationId: 'alerts',
        tags: ['alerts'],
        responses: { '200': { content: { 'text/csv': { schema: {} } } } },
      },
    },
  },
});

interface Ran {
  readonly code: number;
  readonly body: {
    readonly ok: boolean;
    readonly data?: { readonly written?: readonly string[]; readonly operations?: unknown };
    readonly findings?: readonly { readonly code: string; readonly cause: string }[];
  };
}

const run = async (...argv: string[]): Promise<Ran> => {
  const out: string[] = [];
  const code = await dispatch({
    argv: ['client', ...argv, '--json'],
    cwd: root,
    env: {},
    bunVersion: Bun.version,
    write: (line) => out.push(line),
  });
  return { code, body: JSON.parse(out.join('\n')) as Ran['body'] };
};

const writeDoc = (doc: unknown): Promise<number> =>
  Bun.write(join(root, 'weather.json'), JSON.stringify(doc));

describe('x client vendor', () => {
  test('a construct the compiler refuses is X_CLIENT_SPEC_UNSUPPORTED with its pointer', async () => {
    await writeDoc(vendorDoc('celsius'));
    const ran = await run('vendor', 'weather', '--from', 'weather.json');
    expect(ran.code).toBe(1);
    expect(ran.body.findings?.[0]?.code).toBe('X_CLIENT_SPEC_UNSUPPORTED');
    expect(ran.body.findings?.[0]?.cause).toContain('#/paths/~1alerts/get/responses/200/content');
  });

  test('--only around it writes source.json, schemas.ts and client.ts', async () => {
    const ran = await run('vendor', 'weather', '--from', 'weather.json', '--only', 'read');
    expect(ran.body.ok).toBe(true);
    expect(ran.body.data?.operations).toEqual(['forecast']);
    expect(ran.body.data?.written).toEqual([
      'apps/web/clients/weather/source.json',
      'apps/web/clients/weather/schemas.ts',
      'apps/web/clients/weather/client.ts',
    ]);
    expect(await checkClientDrift(root)).toEqual([]);
  });

  test('a hand edit is X_CLIENT_EDITED; regenerating with no flags clears it and keeps --only', async () => {
    const client = Bun.file(join(root, 'apps/web/clients/weather/client.ts'));
    await Bun.write(client, `${await client.text()}\n// mine\n`);
    expect((await checkClientDrift(root)).map((f) => [f.code, f.at])).toEqual([
      ['X_CLIENT_EDITED', 'apps/web/clients/weather/client.ts'],
    ]);
    const again = await run('vendor', 'weather');
    expect(again.body.data?.operations).toEqual(['forecast']);
    expect(await checkClientDrift(root)).toEqual([]);
  });

  test('a moved source is X_CLIENT_STALE whose fix regenerates it', async () => {
    const source = join(root, 'apps/web/clients/weather/source.json');
    const moved = vendorDoc('kelvin');
    await Bun.write(source, JSON.stringify(moved));
    const findings = await checkClientDrift(root);
    expect(findings.map((f) => f.code)).toEqual(['X_CLIENT_STALE', 'X_CLIENT_STALE']);
    expect(findings[0]?.fix).toBe('x client vendor weather --only read --json');
    await run('vendor', 'weather');
    expect(await checkClientDrift(root)).toEqual([]);
  });

  test('reformatting source.json is not a change of contract', async () => {
    const source = join(root, 'apps/web/clients/weather/source.json');
    await Bun.write(source, JSON.stringify(JSON.parse(await Bun.file(source).text())));
    expect(await checkClientDrift(root)).toEqual([]);
  });

  test('not OpenAPI, no source yet, a bad name and an empty --only are each refused', async () => {
    await Bun.write(join(root, 'v2.json'), '{"swagger":"2.0"}');
    expect((await run('vendor', 'old', '--from', 'v2.json')).body.findings?.[0]?.code).toBe(
      'X_CLIENT_SPEC_INVALID',
    );
    expect((await run('vendor', 'nothing')).body.findings?.[0]?.code).toBe('X_CLI_BAD_FLAG');
    expect(
      (await run('vendor', 'Bad_Name', '--from', 'weather.json')).body.findings?.[0]?.code,
    ).toBe('X_CLI_BAD_FLAG');
    expect(
      (await run('vendor', 'weather', '--from', 'weather.json', '--only', 'nope')).body
        .findings?.[0]?.code,
    ).toBe('X_CLI_BAD_FLAG');
  });
});
