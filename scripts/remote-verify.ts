#!/usr/bin/env bun
// Run the gate on a bigger machine over ssh: the working tree (tracked + untracked, never ignored
// files, `.git` included so history-reading suites work) is mirrored to the host, its test services
// start under their own compose project with every host port shifted by a fixed offset (a shared box
// already holds 4222, 5432 …), and `bun run verify` runs there with the shifted URLs. The host is an
// ssh alias the caller names — never written into this repository.
//
//   bun run scripts/remote-verify.ts --host <ssh-alias> [--offset 20000] [--json] [<verify args>]
//   ULTIMATE_REMOTE_HOST=<ssh-alias> bun run gate:remote -- --only unit

import { renderFixShellArg } from '../packages/core/src/error-render';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';

const SCRIPT = 'remote-verify';
/** Where the mirror lives on the host, under its own home: one directory per repository name. */
const REMOTE_DIR = '.cache/ultimate-remote';
/** The compose project the gate's services run under there, apart from any other stack. */
export const REMOTE_PROJECT = 'ultimate-remote-gate';
export const DEFAULT_PORT_OFFSET = 20_000;
/** The whole gate, measured at 23 min on a loaded 8-core laptop: the remote run's ceiling. */
const REMOTE_GATE_TIMEOUT_MS = 3_600_000;
const COMPOSE_FILE = 'docker/docker-compose.test.yml';
const ENV_FILE = 'docker/test-services.env';
const OVERRIDE_FILE = 'docker/.remote-gate.override.yml';

/** `127.0.0.1:5432:5432` → `127.0.0.1:15432:5432`: only the host side moves. */
const shiftBinding = (binding: string, offset: number): string =>
  binding.replace(
    /^((?:\d{1,3}\.){3}\d{1,3}:)?(\d+)(:\d+)$/,
    (_all, ip: string | undefined, host: string, rest: string) =>
      `${ip ?? ''}${String(Number(host) + offset)}${rest}`,
  );

/**
 * A compose override that REPLACES (`!override`, compose ≥ 2.24) each service's published ports with
 * the shifted ones. Read line by line: the test compose file writes every `ports:` as one flow list.
 */
export function shiftedPortsOverride(compose: string, offset: number): string {
  const out: string[] = ['services:'];
  let service: string | undefined;
  for (const line of compose.split('\n')) {
    const named = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (named !== null) service = named[1];
    const ports = /^ {4}ports:\s*\[(.*)\]\s*$/.exec(line);
    if (ports === null || service === undefined) continue;
    const bindings = [...(ports[1] ?? '').matchAll(/'([^']+)'/g)].map(
      (m) => `'${shiftBinding(m[1] ?? '', offset)}'`,
    );
    out.push(`  ${service}:`, `    ports: !override [${bindings.join(', ')}]`);
  }
  return `${out.join('\n')}\n`;
}

/** The services' URLs with each `127.0.0.1:<port>` / `127.0.0.2:<port>` moved by the same offset. */
export const shiftedEnv = (env: string, offset: number): string =>
  env.replace(
    /(127\.0\.0\.[12]):(\d+)/g,
    (_all, ip: string, port: string) => `${ip}:${String(Number(port) + offset)}`,
  );

/** The shell the host runs: install, services, then the gate with this process's exit code. */
export function remoteScript(input: {
  readonly dir: string;
  readonly offset: number;
  readonly verifyArgs: readonly string[];
}): string {
  const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;
  const compose = `docker compose -p ${REMOTE_PROJECT} -f ${COMPOSE_FILE} -f ${OVERRIDE_FILE}`;
  return [
    'set -e',
    `cd ${quote(input.dir)}`,
    'export PATH="$HOME/.bun/bin:$PATH"',
    'bun install --frozen-lockfile >/dev/null',
    `${compose} up -d --wait >/dev/null`,
    'set -a',
    `. ./docker/.remote-gate.env`,
    'set +a',
    'set +e',
    `bun run verify ${input.verifyArgs.map(quote).join(' ')}`.trimEnd(),
  ].join('\n');
}

/** `--host a --offset 5 --json --only unit` → this script's flags, and the gate's words in order. */
export function splitArgs(argv: readonly string[]): {
  readonly own: ReadonlyMap<string, string>;
  readonly verifyArgs: readonly string[];
} {
  const own = new Map<string, string>();
  const verifyArgs: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at] ?? '';
    if (word === '--json') own.set('json', 'true');
    else if ((word === '--host' || word === '--offset') && at + 1 < argv.length) {
      own.set(word.slice(2), argv[at + 1] ?? '');
      at++;
    } else if (word !== '--') verifyArgs.push(word);
  }
  return { own, verifyArgs };
}

/** Every path the mirror carries: what git tracks or would track, plus `.git` itself. */
async function syncList(root: string): Promise<string> {
  const listed = await run(['git', 'ls-files', '-co', '--exclude-standard'], { cwd: root });
  if (!listed.ok) return '';
  return `${listed.output.trimEnd()}\n.git/\n`;
}

async function main(): Promise<void> {
  // `bun run` swallows a `--`, so the split is by name: this script's three flags, and every other
  // word is the gate's (`--only unit`, `--shard 1/3` …).
  const { own, verifyArgs } = splitArgs(Bun.argv.slice(2));
  const args = { flags: own };
  const json = args.flags.has('json');
  const host = args.flags.get('host') ?? Bun.env['ULTIMATE_REMOTE_HOST'];
  const offset = Number(args.flags.get('offset') ?? DEFAULT_PORT_OFFSET);
  const refuse = (finding: Finding): never =>
    report(
      { ok: false, script: SCRIPT, summary: 'the remote gate did not run', findings: [finding] },
      json,
    );
  if (host === undefined || host === '' || !/^[\w.@-]+$/.test(host)) {
    refuse({
      code: 'X_REMOTE_VERIFY_HOST_MISSING',
      cause: 'no ssh host named, or one that is not a plain ssh alias',
      fix: 'ULTIMATE_REMOTE_HOST=<ssh-alias> bun run scripts/remote-verify.ts -- --only unit',
    });
    return;
  }
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > 50_000) {
    refuse({
      code: 'X_REMOTE_VERIFY_HOST_MISSING',
      cause: `--offset must be a whole number of ports between 1 and 50000, got ${String(offset)}`,
      fix: 'bun run scripts/remote-verify.ts --host <ssh-alias> --offset 20000',
    });
    return;
  }
  const root = repoRoot();
  const name = root.split('/').filter(Boolean).at(-1) ?? 'ultimate';
  const dir = `${REMOTE_DIR}/${name}`;
  await Bun.write(
    `${root}/${OVERRIDE_FILE}`,
    shiftedPortsOverride(await Bun.file(`${root}/${COMPOSE_FILE}`).text(), offset),
  );
  await Bun.write(
    `${root}/docker/.remote-gate.env`,
    shiftedEnv(await Bun.file(`${root}/${ENV_FILE}`).text(), offset),
  );
  const list = `${root}/node_modules/.cache/remote-verify.list`;
  await Bun.write(list, `${await syncList(root)}${OVERRIDE_FILE}\ndocker/.remote-gate.env\n`);
  const prepared = await run(['ssh', '-o', 'BatchMode=yes', host, `mkdir -p ${dir}`], {
    cwd: root,
    timeoutMs: 30_000,
  });
  const synced = prepared.ok
    ? await run(['rsync', '-az', '--recursive', `--files-from=${list}`, './', `${host}:${dir}/`], {
        cwd: root,
        timeoutMs: 900_000,
      })
    : prepared;
  if (!synced.ok) {
    refuse({
      code: 'X_REMOTE_VERIFY_SYNC_FAILED',
      cause: `the tree did not reach ${host}: ${synced.output.trim().split('\n').slice(-2).join(' / ').slice(0, 300)}`,
      fix: `ssh -o BatchMode=yes ${renderFixShellArg(host, '<ssh-alias>')} true   # then rerun; rsync and docker compose >= 2.24 must be on the host`,
    });
    return;
  }
  const started = performance.now();
  const gate = Bun.spawn(['ssh', '-o', 'BatchMode=yes', host, 'bash', '-s'], {
    stdin: new TextEncoder().encode(remoteScript({ dir, offset, verifyArgs })),
    stdout: 'inherit',
    stderr: 'inherit',
    timeout: REMOTE_GATE_TIMEOUT_MS,
  });
  const code = await gate.exited;
  const seconds = Math.round((performance.now() - started) / 1000);
  process.stderr.write(
    `remote-verify: ${host} answered exit ${String(code)} in ${String(seconds)} s\n`,
  );
  process.exit(code);
}

if (import.meta.main) await main();
