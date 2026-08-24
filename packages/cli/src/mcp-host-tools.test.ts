// The shell-side half of the dev host — `mcp-host.ts`'s `capabilities()` — driven through the
// real server against a fixture app root. `mcp-host.test.ts` covers the catalog and the pure
// readers with a fake `DevHost`; this file is the other direction: the REAL capability object,
// so a tool that shells out, reads a log or reads the manifest is exercised on the code path an
// agent actually reaches. The three capabilities that need a live Postgres (`db.query`,
// `db.migrate`, `queue.depth`) are deliberately absent — they belong in a `.live.` suite.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import type { JsonRpcResponse, ToolArgs } from '@ultimat3/mcp';
import { resetAppLoad } from './app-load';
import { VERIFY_STEPS } from './cmd-verify';
import type { ExecResult, Runner } from './exec';
import type { CliMcpServer } from './mcp-host';
import { createDevMcpServer } from './mcp-host';

// Dot-prefixed and under `packages/cli/`, exactly as `cmd-mcp.test.ts`'s fixture: out of every
// workspace glob, and resolving `@ultimat3/*` through the same tsconfig paths.
const ROOT = join(import.meta.dir, '..', '.mcp-host-fixture');
const STATE = join(ROOT, '.x');

interface RunnerCall {
  readonly command: readonly string[];
  readonly cwd: string;
}

function recordingRunner(stdoutFor: (command: readonly string[]) => string): {
  runner: Runner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const runner: Runner = async (command, options) => {
    calls.push({ command, cwd: options.cwd });
    const result: ExecResult = {
      command,
      code: 0,
      ok: true,
      stdout: stdoutFor(command),
      stderr: '',
      durationMs: 7,
    };
    return result;
  };
  return { runner, calls };
}

const PASSING = `bun test v1.3.14 (0d9b296a)

 4 pass
 0 fail
 9 expect() calls
Ran 4 tests across 1 file. [12.00ms]`;

let calls: RunnerCall[];
let host: CliMcpServer;

const call = (name: string, args: ToolArgs = {}): Promise<JsonRpcResponse | null> =>
  host.server.handle(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    host.caller,
  );

const resultOf = (
  response: JsonRpcResponse | null,
): { text: string; isError: boolean; json: unknown } => {
  const result = response?.result as
    | { content?: readonly { readonly text?: string }[]; isError?: boolean }
    | undefined;
  const text = result?.content?.[0]?.text ?? '';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { text, isError: result?.isError === true, json };
};

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'mcp-host-fixture', version: '1.0.0' }),
  );
  await Bun.write(join(ROOT, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  resetAppLoad();
  const recording = recordingRunner(() => PASSING);
  calls = recording.calls;
  // Builds the REAL capability object: `databaseTarget` runs here, nothing else does.
  host = await createDevMcpServer({ root: ROOT, env: {}, runner: recording.runner });
  // 30s for the reason `mcp-host.test.ts` and `cmd-mcp.test.ts` both say so: `loadCodeFixes()`
  // reads every installed package's source once, and this is the call that awaits it.
}, 30_000);

afterAll(async () => {
  await host.close();
  await rm(ROOT, { recursive: true, force: true });
  resetAppLoad();
});

describe('tests.run shells out to bun test in the app root', () => {
  test('no filter runs the whole suite, and the parsed counts come back', async () => {
    calls.length = 0;
    const { json, isError } = resultOf(await call('tests.run'));
    expect(calls).toEqual([{ command: ['bun', 'test'], cwd: ROOT }]);
    expect(isError).toBe(false);
    expect(json).toEqual({
      passed: 4,
      failed: 0,
      skipped: 0,
      durationMs: 7,
      failures: [],
    });
  });

  test('a filter is appended as bun test’s own path argument', async () => {
    calls.length = 0;
    await call('tests.run', { filter: 'packages/seo' });
    expect(calls).toEqual([{ command: ['bun', 'test', 'packages/seo'], cwd: ROOT }]);
  });
});

describe('logs.tail reads the dev log off disk', () => {
  test('a missing log is refused with a command that creates one, not an empty array', async () => {
    await rm(join(STATE, 'dev.log'), { force: true });
    const { text, isError } = resultOf(await call('logs.tail'));
    expect(isError).toBe(true);
    expect(text).toContain('X_NOT_IMPLEMENTED');
    expect(text).toContain(`x dev > ${join(STATE, 'dev.log')} 2>&1`);
  });

  test('a per-role tail names the role’s own file and its own fix', async () => {
    const { text, isError } = resultOf(await call('logs.tail', { role: 'worker' }));
    expect(isError).toBe(true);
    expect(text).toContain(join(STATE, 'logs', 'worker.log'));
    expect(text).toContain('x dev --role worker');
  });

  test('the tail is the LAST n lines, and the trailing newline is not one of them', async () => {
    await Bun.write(join(STATE, 'dev.log'), 'one\ntwo\nthree\nfour\n');
    expect(resultOf(await call('logs.tail', { lines: 2 })).text).toBe('three\nfour');
    // The default is 100, so a four-line log comes back whole rather than truncated.
    expect(resultOf(await call('logs.tail')).text).toBe('one\ntwo\nthree\nfour');
  });

  test('a role’s log is read from logs/<role>.log, never from dev.log', async () => {
    await Bun.write(join(STATE, 'logs', 'worker.log'), 'worker line\n');
    expect(resultOf(await call('logs.tail', { role: 'worker' })).text).toBe('worker line');
    // dev.log still holds its own four lines — the two paths are not the same file.
    expect(resultOf(await call('logs.tail')).text).toBe('one\ntwo\nthree\nfour');
  });
});

describe('manifest.read prefers the committed file', () => {
  test('the generated file on disk is handed back verbatim', async () => {
    const committed = '{\n  "buildId": "committed-by-x-manifest"\n}';
    await Bun.write(join(ROOT, MANIFEST_FILENAME), committed);
    expect(resultOf(await call('manifest.read')).text).toBe(committed);
  });

  test('an app that never ran x manifest still gets a manifest, not a failure', async () => {
    await rm(join(ROOT, MANIFEST_FILENAME), { force: true });
    const { text, isError } = resultOf(await call('manifest.read'));
    expect(isError).toBe(false);
    const manifest = JSON.parse(text) as { buildId?: string; version?: unknown };
    expect(manifest.buildId).toBeString();
    expect(manifest.buildId).not.toBe('committed-by-x-manifest');
  }, 30_000);
});

describe('verify.run is the gate, run through the injected runner', () => {
  interface VerifyPayload {
    readonly ok: boolean;
    readonly steps: readonly { readonly name: string; readonly ok: boolean; detail?: string }[];
  }

  // Removed here rather than left to whichever test ran last: a fixture with no committed
  // manifest fails exactly the `manifest` step, which is what makes `ok: false` a fact of this
  // describe and not of the file's ordering.
  beforeAll(async () => {
    await rm(join(ROOT, MANIFEST_FILENAME), { force: true });
  });

  test('a failing step makes the whole answer an error, and carries its cause as detail', async () => {
    calls.length = 0;
    const { json, isError } = resultOf(await call('verify.run'));
    const report = json as VerifyPayload;
    expect(report.steps.map((step) => step.name)).toEqual(VERIFY_STEPS.map((step) => step.name));
    expect(report.ok).toBe(false);
    expect(isError).toBe(true);

    const failed = report.steps.filter((step) => !step.ok);
    expect(failed.map((step) => step.name)).toEqual(['manifest']);
    // The step's OWN finding, not a generic sentence: this is the only text the agent gets back
    // for a red step, so it has to name a file the manifest step could not read. The fixture
    // deletes `x.manifest.json` above and ships no `AGENTS.md`, and both are findings of this one
    // step — the absent manifest leads, because it is the fact the drift half depends on.
    expect(failed[0]?.detail).toContain(`${MANIFEST_FILENAME} does not exist`);
    // A step that passed carries no detail — the gate's per-step text is a failure channel.
    expect(report.steps.filter((step) => step.ok && step.detail !== undefined)).toEqual([]);

    // The one autofix `x verify --fix` has, and it must not run on a plain call.
    expect(calls.some((entry) => entry.command.includes('--write'))).toBe(false);
  }, 60_000);

  test('fix: true runs biome --write FIRST, before any step is judged', async () => {
    calls.length = 0;
    await call('verify.run', { fix: true });
    expect(calls[0]).toEqual({
      command: ['bunx', 'biome', 'check', '--write', '.'],
      cwd: ROOT,
    });
  }, 60_000);
});
