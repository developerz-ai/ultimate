// The agent-facing check, proved against a fake app that answers the way a scaffolded one does —
// and against each way it could be wrong while still answering something. No process is spawned and
// no server booted here: CI's `scaffold-smoke` job is the real run.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no mkdtemp/rm and exposes no tmpdir(); each case owns a throwaway app directory.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AgentCheckIo } from './scaffold-agent';
import { checkAgent, DEV_AGENT_TOKEN, mcpCommand, PROBE_TOOL, toolNames } from './scaffold-agent';

const MCP_JSON = {
  mcpServers: {
    demo: { command: 'bunx', args: ['@ultimat3/cli', 'mcp', 'serve', '--transport', 'stdio'] },
  },
};

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A directory that looks installed: an `x` binary and the `.mcp.json` given. */
async function app(mcpJson: unknown = MCP_JSON): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/scaffold-agent-`);
  dirs.push(dir);
  await mkdir(`${dir}/node_modules/.bin`, { recursive: true });
  await Bun.write(`${dir}/node_modules/.bin/x`, '#!/bin/sh\n');
  await Bun.write(`${dir}/.mcp.json`, JSON.stringify(mcpJson));
  return dir;
}

interface Fake {
  readonly stdioTools?: readonly string[];
  readonly anonymousStatus?: number;
  readonly endpointTools?: readonly string[];
  readonly callIsError?: boolean;
  readonly bootLog?: string;
  /** Status for the development token sent WITH an Origin — what a rebound browser page sends. */
  readonly browserStatus?: number;
}

const listAnswer = (id: number, names: readonly string[]) => ({
  jsonrpc: '2.0',
  id,
  result: { tools: names.map((name) => ({ name })) },
});

/** A scaffolded app in a few lines: the stdio server, `x dev`, and its `POST /mcp`. */
function fakeIo(fake: Fake = {}) {
  const spawned: (readonly string[])[] = [];
  let stopped = 0;
  const io: AgentCheckIo = {
    stdio: async (_dir, argv) => {
      spawned.push(argv);
      return [
        { jsonrpc: '2.0', id: 1, result: {} },
        listAnswer(2, fake.stdioTools ?? ['routes.list']),
      ];
    },
    boot: () => ({
      exited: () => false,
      stop: async () => {
        stopped += 1;
        return fake.bootLog ?? '{"msg":"app mcp mounted","path":"/mcp"}';
      },
    }),
    fetcher: async (url, init) => {
      const body = JSON.parse(String(init.body)) as { method: string };
      const headers = new Headers(init.headers);
      const token = headers.get('authorization');
      const origin = headers.get('origin');
      // The route's own rule (core's proveSameOrigin): an Origin that is not this app is 403 before
      // any token is read, so only a SAME-origin page — what a rebound name is — reaches the
      // resolver's no-Origin rule under test.
      if (origin !== null && origin !== new URL(url).origin)
        return new Response('{}', { status: 403 });
      if (origin !== null) return new Response('{}', { status: fake.browserStatus ?? 401 });
      if (token !== `Bearer ${DEV_AGENT_TOKEN}`) {
        return new Response('{}', { status: fake.anonymousStatus ?? 401 });
      }
      if (body.method === 'tools/list') {
        return Response.json(listAnswer(2, fake.endpointTools ?? [PROBE_TOOL]));
      }
      return Response.json({
        jsonrpc: '2.0',
        id: 3,
        result: { isError: fake.callIsError ?? false },
      });
    },
    port: () => 4321,
    now: () => 0,
    sleep: async () => undefined,
  };
  return { io, spawned, stopped: () => stopped };
}

describe('unit · scaffold-agent reads what a cold agent reads', () => {
  test('the server command is the first server in .mcp.json, as an argv', () => {
    expect(mcpCommand(MCP_JSON)).toEqual([
      'bunx',
      '@ultimat3/cli',
      'mcp',
      'serve',
      '--transport',
      'stdio',
    ]);
    expect(mcpCommand({})).toBeUndefined();
    expect(mcpCommand({ mcpServers: { a: { command: 'bunx', args: [1] } } })).toBeUndefined();
    expect(toolNames(listAnswer(2, ['a', 'b']))).toEqual(['a', 'b']);
    expect(toolNames({ error: {} })).toEqual([]);
  });

  test('a scaffold that answers every question is green, spawning the file’s own command', async () => {
    const fake = fakeIo();
    const result = await checkAgent(await app(), fake.io);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(fake.spawned).toEqual([
      ['bunx', '@ultimat3/cli', 'mcp', 'serve', '--transport', 'stdio'],
    ]);
    expect(fake.stopped()).toBe(1);
  });

  const cases: readonly [string, Fake, string][] = [
    ['an empty stdio catalog', { stdioTools: [] }, '0 tool(s)'],
    ['an endpoint that answers without a token', { anonymousStatus: 200 }, 'not 401'],
    ['an endpoint that is not mounted', { anonymousStatus: 404 }, 'not 401'],
    ['a catalog without health', { endpointTools: ['other'] }, `no ${PROBE_TOOL}`],
    ['a health call that fails', { callIsError: true }, `tools/call ${PROBE_TOOL}`],
    [
      'a boot that warns unmounted',
      { bootLog: 'X_MCP_APP_UNMOUNTED app mcp mounted' },
      'X_MCP_APP_UNMOUNTED',
    ],
    ['a boot that never mounts', { bootLog: 'ready' }, 'never says app mcp mounted'],
    ['a dev token honoured from a browser', { browserStatus: 200 }, 'with an Origin answered 200'],
  ];
  for (const [name, fake, cause] of cases) {
    test(`${name} is a finding`, async () => {
      const result = await checkAgent(await app(), fakeIo(fake).io);
      expect(result.ok).toBe(false);
      expect(result.findings?.map((finding) => finding.cause).join(' | ')).toContain(cause);
    });
  }

  test('a .mcp.json that names no server is a finding, and nothing is spawned', async () => {
    const fake = fakeIo();
    const result = await checkAgent(await app({}), fake.io);
    expect(result.findings?.[0]?.cause).toContain('names no server command');
    expect(fake.spawned).toEqual([]);
  });

  test('an app that was never installed is refused before anything runs', async () => {
    const dir = await mkdtemp(`${tmpdir()}/scaffold-agent-`);
    dirs.push(dir);
    const result = await checkAgent(dir, fakeIo().io);
    expect(result.findings?.[0]?.fix).toContain('bun run setup');
  });
});
