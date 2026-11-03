#!/usr/bin/env bun
// A new app, as a coding agent arriving cold meets it: the command `.mcp.json` names answers an MCP
// `initialize` and a non-empty `tools/list`, and the app's own `POST /mcp` is mounted under `x dev`
// — 401 with no token, `health` listed and callable with the development token, and a boot log
// that says `app mcp mounted` rather than X_MCP_APP_UNMOUNTED. Run by `scaffold-smoke` per push.
//
//   bun run scripts/scaffold-agent.ts <app dir> [--json]

import { DEV_BINDING, quoteArg } from '@ultimat3/cli';
import { renderThrowable } from '@ultimat3/core';
import { parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { appDirWord, type DevServer } from './scaffold-admin';
import { appBin } from './scaffold-first-run';

const SCRIPT = 'scaffold-agent';
const MCP_JSON = '.mcp.json';
/** What the scaffold's `apps/web/app/auth/agent-token.ts` honours under `x dev` alone. */
export const DEV_AGENT_TOKEN = 'dev-agent.admin';
/** The action every scaffold exposes over MCP (`apps/web/api/health.ts`). */
export const PROBE_TOOL = 'health';
const BOOT_BUDGET_MS = 60_000;
/** The dev server's whole life: boot, then a handful of requests. A check that outlives it hung. */
const SERVE_BUDGET_MS = 3 * BOOT_BUDGET_MS;

/** The one server `.mcp.json` names, as an argv — or `undefined` when the file says none. */
export function mcpCommand(config: unknown): readonly string[] | undefined {
  const servers = (config as { readonly mcpServers?: unknown } | null)?.mcpServers;
  if (typeof servers !== 'object' || servers === null) return undefined;
  const [first] = Object.values(servers as Record<string, unknown>);
  const { command, args } = (first ?? {}) as { command?: unknown; args?: unknown };
  if (typeof command !== 'string' || !Array.isArray(args)) return undefined;
  return args.every((arg) => typeof arg === 'string') ? [command, ...args] : undefined;
}

/** A JSON-RPC request, numbered by the caller so answers are matched by `id`. */
export const rpc = (id: number, method: string, params: unknown = {}) => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
});

export const INITIALIZE = rpc(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: SCRIPT, version: '0' },
});

/** The tool names a `tools/list` answer carries; `[]` for anything that is not one. */
export function toolNames(answer: unknown): readonly string[] {
  const tools = (answer as { readonly result?: { readonly tools?: unknown } } | null)?.result
    ?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool: unknown) => {
    const name = (tool as { readonly name?: unknown } | null)?.name;
    return typeof name === 'string' ? [name] : [];
  });
}

export interface AgentCheckIo {
  /** Spawn `argv` in `dir`, write each message as one NDJSON line, answer the replies by `id`. */
  readonly stdio: (
    dir: string,
    argv: readonly string[],
    messages: readonly unknown[],
  ) => Promise<readonly unknown[]>;
  readonly boot: (dir: string, port: number) => DevServer;
  readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  readonly port: () => number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const finding = (dir: string, cause: string, fix: string): Finding => ({
  code: 'X_SCAFFOLD_FIRST_RUN_FAILED',
  cause,
  fix,
  at: dir,
});

/** The `.mcp.json` half: the file's own command, a handshake, a catalog. */
async function checkStdio(dir: string, io: AgentCheckIo): Promise<readonly Finding[]> {
  const file = Bun.file(`${dir}/${MCP_JSON}`);
  const argv = (await file.exists()) ? mcpCommand(await file.json()) : undefined;
  const where = quoteArg(appDirWord(dir));
  if (argv === undefined) {
    return [
      finding(dir, `${dir}/${MCP_JSON} names no server command`, `cd ${where} && cat .mcp.json`),
    ];
  }
  const answers = await io.stdio(dir, argv, [INITIALIZE, rpc(2, 'tools/list')]);
  const initialized = answers.some((answer) => (answer as { id?: unknown } | null)?.id === 1);
  const tools = toolNames(answers.find((answer) => (answer as { id?: unknown } | null)?.id === 2));
  if (initialized && tools.length > 0) return [];
  return [
    finding(
      dir,
      `${argv.join(' ')} (from ${MCP_JSON}) answered ${initialized ? '' : 'no initialize and '}${String(tools.length)} tool(s)`,
      `bun run scripts/scaffold-agent.ts ${where} --json`,
    ),
  ];
}

const post = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  },
  body: JSON.stringify(body),
});

/** The `POST /mcp` half, over a running `x dev`: refused, then listed, then called. */
async function askEndpoint(url: string, io: AgentCheckIo): Promise<readonly string[]> {
  const problems: string[] = [];
  const anonymous = await io.fetcher(url, post(rpc(1, 'tools/list')));
  if (anonymous.status !== 401)
    problems.push(`POST /mcp with no token answered ${String(anonymous.status)}, not 401`);
  // A browser sends Origin on every POST, and a page that rebinds its name to 127.0.0.1 is one: the
  // development token must buy it nothing.
  const fromPage = await io.fetcher(url, {
    ...post(rpc(4, 'tools/list'), DEV_AGENT_TOKEN),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${DEV_AGENT_TOKEN}`,
      origin: 'http://rebound.test',
    },
  });
  if (fromPage.status !== 401)
    problems.push(
      `the development token with an Origin answered ${String(fromPage.status)}, not 401`,
    );
  const listed = toolNames(
    await (await io.fetcher(url, post(rpc(2, 'tools/list'), DEV_AGENT_TOKEN))).json(),
  );
  if (!listed.includes(PROBE_TOOL))
    problems.push(
      `tools/list with the development token lists [${listed.join(', ')}], no ${PROBE_TOOL}`,
    );
  const called: unknown = await (
    await io.fetcher(
      url,
      post(rpc(3, 'tools/call', { name: PROBE_TOOL, arguments: {} }), DEV_AGENT_TOKEN),
    )
  ).json();
  const result = (called as { readonly result?: { readonly isError?: unknown } } | null)?.result;
  if (result === undefined || result.isError === true)
    problems.push(`tools/call ${PROBE_TOOL} answered ${JSON.stringify(called).slice(0, 200)}`);
  return problems;
}

/** Boot `x dev`, ask the endpoint, stop it — always — and judge what it printed. */
async function checkEndpoint(dir: string, io: AgentCheckIo): Promise<readonly Finding[]> {
  const port = io.port();
  const url = `http://${DEV_BINDING.hostname}:${String(port)}/mcp`;
  const fix = `cd ${quoteArg(appDirWord(dir))} && bun run dev --port ${quoteArg(String(port))}`;
  const started = io.now();
  const server = io.boot(dir, port);
  let up = false;
  let lastDial = 'no dial was made';
  let problems: readonly string[] = [];
  let output = '';
  try {
    while (!up && !server.exited() && io.now() - started < BOOT_BUDGET_MS) {
      up = await io.fetcher(url, post(rpc(0, 'ping'))).then(
        () => true,
        (error: unknown) => {
          lastDial = renderThrowable(error);
          return false;
        },
      );
      if (!up) await io.sleep(100);
    }
    if (up) problems = await askEndpoint(url, io);
  } finally {
    output = await server.stop();
  }
  if (!up) return [finding(dir, `x dev answered nothing at ${url}: ${lastDial}`, fix)];
  const log: string[] = [];
  if (output.includes('X_MCP_APP_UNMOUNTED')) log.push('the boot log carries X_MCP_APP_UNMOUNTED');
  if (!output.includes('app mcp mounted')) log.push('the boot log never says app mcp mounted');
  return [...problems, ...log].map((problem) => finding(dir, problem, fix));
}

export async function checkAgent(dir: string, io: AgentCheckIo): Promise<ScriptResult> {
  if (!(await Bun.file(appBin(dir)).exists())) {
    const where = quoteArg(appDirWord(dir));
    const findings = [
      finding(
        dir,
        `${appBin(dir)} does not exist, so the app cannot be booted`,
        `cd ${where} && bun run setup`,
      ),
    ];
    return { ok: false, script: SCRIPT, summary: `no x binary in ${dir}`, findings };
  }
  const findings = [...(await checkStdio(dir, io)), ...(await checkEndpoint(dir, io))];
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${dir}: ${MCP_JSON} answers initialize and tools/list; POST /mcp refuses no token and serves ${PROBE_TOOL} to the development agent`
        : `${String(findings.length)} agent-facing finding(s) in ${dir}`,
    findings,
  };
}

/** Every reply line that carries an `id`, until each asked `id` has one or the budget is spent. */
async function stdioAnswers(dir: string, argv: readonly string[], messages: readonly unknown[]) {
  const child = Bun.spawn([...argv], {
    cwd: dir,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: BOOT_BUDGET_MS,
  });
  child.stdin.write(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
  await child.stdin.flush();
  const answers: unknown[] = [];
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const deadline = Bun.sleep(BOOT_BUDGET_MS).then(() => 'timeout' as const);
  try {
    while (answers.length < messages.length) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'timeout' || next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines.filter((one) => one.trim().startsWith('{'))) {
        const parsed: unknown = JSON.parse(line);
        if ((parsed as { id?: unknown } | null)?.id !== undefined) answers.push(parsed);
      }
    }
  } finally {
    child.kill();
    await child.exited;
  }
  return answers;
}

/** The real thing: the file's own command, the app's own `x dev`, a free port, the wall clock. */
const realIo: AgentCheckIo = {
  stdio: stdioAnswers,
  boot: (dir, port) => {
    const server = Bun.spawn([appBin(dir), 'dev', '--port', String(port), '--json'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: SERVE_BUDGET_MS,
    });
    const printed = Promise.all([
      new Response(server.stdout).text(),
      new Response(server.stderr).text(),
    ]);
    return {
      exited: () => server.exitCode !== null,
      stop: async () => {
        server.kill('SIGTERM');
        await server.exited;
        return (await printed).join('\n');
      },
    };
  },
  fetcher: fetch,
  // A port nothing holds right now, on the address `x dev` binds — the rule `scaffold-admin.ts` keeps.
  port: () => {
    const probe = Bun.listen({
      hostname: DEV_BINDING.hostname,
      port: 0,
      socket: { data: () => undefined },
    });
    const { port } = probe;
    probe.stop(true);
    return port;
  },
  now: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const dir = args.positionals[0];
  report(
    dir === undefined
      ? {
          ok: false,
          script: SCRIPT,
          summary: 'a scaffolded app directory is required',
          findings: [
            finding(
              'scripts/scaffold-agent.ts',
              'no app directory given, so there is no scaffolded app to ask',
              'bun run scripts/scaffold-agent.ts /tmp/demoapp --json',
            ),
          ],
        }
      : await checkAgent(dir, realIo),
    args.json,
  );
}
