// The `x upgrade` tests' world: a real git fixture and a recording runner. Git is real, because a dirty
// tree and `git diff guards/` are the promises; `bun` is scripted, because a real hop is the e2e's. A
// run goes through `dispatch`, so `--json` and the exit code are what an agent actually receives.

import { expect } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';

export { REQUIRED_BUN } from './app-root';

import { REQUIRED_BUN } from './app-root';
import { dispatch } from './dispatch';
import type { ExecResult, Runner } from './exec';
import { exec } from './exec';

export const dirs: string[] = [];
/** Each test file's own `afterEach`: a hook made here would bind to whichever file loaded this first. */
export const removeFixtures = (): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

export const git = async (cwd: string, ...args: readonly string[]): Promise<string> =>
  (await exec(['git', '-c', 'user.name=t', '-c', 'user.email=t@t.t', ...args], { cwd })).stdout;

const GUARD = 'guards/no-raw-colors.ts';

export const fixture = async (files: Readonly<Record<string, string>> = {}): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'ultimate-upgrade-'));
  dirs.push(dir);
  const all: Readonly<Record<string, string>> = {
    'app.config.ts': 'export const config = {};\n',
    'package.json': `${JSON.stringify(
      {
        name: 'app',
        workspaces: ['apps/*'],
        engines: { bun: '>=1.3.0' },
        dependencies: { '@ultimat3/cli': '^19.4.0', '@ultimat3/core': '^19.4.0' },
      },
      null,
      2,
    )}\n`,
    'apps/web/package.json': `${JSON.stringify(
      { name: 'web', dependencies: { '@ultimat3/core': '^19.4.0', sass: '^1.0.0' } },
      null,
      2,
    )}\n`,
    '.bun-version': '1.3.14\n',
    '.github/workflows/ci.yml': "        bun-version: '1.3.14'\n",
    'docker/Dockerfile':
      'FROM oven/bun:1.3-alpine AS deps\nFROM oven/bun:1.4-alpine@sha256:d888c0 AS runtime\n',
    [GUARD]: '// my own edit of this guard\n',
    ...files,
  };
  await Promise.all(Object.entries(all).map(([path, text]) => Bun.write(join(dir, path), text)));
  await git(dir, 'init', '-q');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'init');
  return dir;
};

const answer = (command: readonly string[], stdout: string, code = 0, stderr = ''): ExecResult => ({
  command,
  code,
  ok: code === 0,
  stdout,
  stderr,
  durationMs: 1,
});

export const VERIFY_GREEN = JSON.stringify({
  ok: true,
  command: 'verify',
  summary: 'gate green',
  steps: [],
});
export const VERIFY_RED = JSON.stringify({
  ok: false,
  command: 'verify',
  summary: '1 of 20 steps failed',
  steps: [
    {
      name: 'typecheck',
      ok: false,
      findings: [
        {
          code: 'X_TYPECHECK_FAILED',
          cause: 'apps/web/a.ts(1,1): TS2322',
          fix: 'x verify --only typecheck',
          at: 'apps/web/a.ts',
          meta: { step: 'typecheck' },
        },
      ],
    },
    { name: 'lint', ok: true, findings: [] },
  ],
});
const DOCTOR = JSON.stringify({
  ok: true,
  data: {
    guards: {
      missing: [{ name: 'no-eval', add: 'x g guard no-eval' }],
      differs: [{ name: 'no-raw-colors', refresh: 'x g guard no-raw-colors --force' }],
    },
  },
});

interface Script {
  readonly versions?: readonly string[];
  readonly registryCode?: number;
  readonly engines?: string;
  readonly installCode?: number;
  readonly doctor?: string;
  readonly verify?: string;
  readonly verifyCode?: number;
  readonly manifestCode?: number;
  /** Exit code per `bun run <script>`; a script not named here exits 0. */
  readonly scriptCodes?: Readonly<Record<string, number>>;
}

/** Git runs for real; everything `process.execPath` would run is the script, recorded in order. */
export const recording = (script: Script = {}): { runner: Runner; spawned: string[] } => {
  const spawned: string[] = [];
  const runner: Runner = async (command, options) => {
    if (command[0] === 'git') return exec(command, options);
    expect(command[0]).toBe(process.execPath);
    const args = command.slice(1);
    const label = args[0]?.endsWith('bin.ts') ? `x ${args[1]}` : args.slice(0, 2).join(' ');
    spawned.push(label);
    switch (label) {
      case 'pm view':
        if ((script.registryCode ?? 0) !== 0) {
          return answer(command, '', script.registryCode, 'ConnectionRefused');
        }
        return args.at(-2) === 'versions'
          ? answer(
              command,
              JSON.stringify(script.versions ?? ['19.4.0', '20.0.0', '20.1.0', '21.0.0']),
            )
          : answer(command, JSON.stringify({ bun: script.engines ?? `>=${REQUIRED_BUN}` }));
      case 'run typecheck':
      case 'run test':
        return answer(
          command,
          `output of ${args[1]}`,
          new Map(Object.entries(script.scriptCodes ?? {})).get(args[1] ?? '') ?? 0,
        );
      case 'install':
        return answer(
          command,
          '',
          script.installCode ?? 0,
          'error: @ultimat3/gone@20.1.0 not found',
        );
      case 'x manifest':
        return answer(
          command,
          JSON.stringify({ ok: (script.manifestCode ?? 0) === 0 }),
          script.manifestCode ?? 0,
        );
      case 'x doctor':
        return answer(command, script.doctor ?? DOCTOR);
      case 'x verify':
        return answer(command, script.verify ?? VERIFY_GREEN, script.verifyCode ?? 0);
      default:
        return expect.unreachable(`an unscripted spawn: ${label}`);
    }
  };
  return { runner, spawned };
};

interface Output {
  readonly ok: boolean;
  readonly summary: string;
  readonly findings?: readonly { code: string; cause: string; fix: string }[];
  readonly data?: {
    readonly from: string;
    readonly to: string;
    readonly next: string | null;
    readonly done: boolean;
    readonly dryRun: boolean;
    readonly app: boolean;
    readonly proof: string;
    readonly scripts: readonly { name: string; ok: boolean | null; code?: number }[];
    readonly then: string;
    readonly section: { title: string; url: string } | null;
    readonly pins: readonly { file: string; name: string; from: string; to: string }[];
    readonly bun: {
      readonly from: string | null;
      readonly to: string | null;
      readonly edited: readonly { path: string; site: string; from: string; to: string }[];
      readonly manual: readonly { path: string; line: number; why: string }[];
    };
    readonly guards: {
      readonly reported: boolean;
      readonly missing: readonly { name: string; add: string }[];
      readonly differs: readonly { name: string; refresh: string }[];
    } | null;
    readonly manifest: { ok: boolean } | null;
    readonly verify: {
      readonly ok: boolean;
      readonly summary: string;
      readonly failed: readonly string[];
      readonly findings: readonly {
        step?: string;
        code: string;
        cause: string;
        fix: string;
        at?: string;
      }[];
    } | null;
  };
}

export const run = async (
  dir: string,
  runner: Runner,
  extra: readonly string[] = [],
  options: { readonly json?: boolean; readonly bunVersion?: string } = {},
): Promise<{ code: number; lines: readonly string[]; output: Output }> => {
  const lines: string[] = [];
  const code = await dispatch({
    argv: ['upgrade', ...(options.json === false ? [] : ['--json']), ...extra],
    cwd: dir,
    env: {},
    bunVersion: options.bunVersion ?? REQUIRED_BUN,
    runner,
    write: (line) => lines.push(line),
    writeError: () => undefined,
  });
  const output = options.json === false ? ({} as Output) : (JSON.parse(lines.join('\n')) as Output);
  return { code, lines, output };
};

/** ggrts's shape: pins and scripts in the workspaces, and no `app.config.ts` anywhere. */
export const fixtureWithoutApp = async (
  scripts: Readonly<Record<string, string>> = { typecheck: 'tsc', test: 'bun test', lint: 'biome' },
): Promise<string> => {
  const dir = await fixture({
    'package.json': `${JSON.stringify(
      {
        name: 'ggrts',
        workspaces: ['apps/*'],
        scripts,
        dependencies: { '@ultimat3/core': '^19.4.0' },
      },
      null,
      2,
    )}\n`,
  });
  rmSync(join(dir, 'app.config.ts'));
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-qm', 'no app');
  return dir;
};
