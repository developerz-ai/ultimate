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
export const EXERCISE_GREEN = JSON.stringify({ ok: true, command: 'exercise', findings: [] });
export const EXERCISE_RED = JSON.stringify({
  ok: false,
  command: 'exercise',
  summary: '1 of 3 primitives refused',
  findings: [
    {
      code: 'X_EXERCISE_INPUT_THREW',
      cause: 'the input function of createPost threw before the pass could call it',
      fix: 'x exercise createPost --json   # after the entry input in apps/web/exercise.ts returns a value',
      at: 'apps/web/exercise.ts',
      meta: { primitive: 'createPost' },
    },
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
  readonly exercise?: string;
  readonly exerciseCode?: number;
  readonly verify?: string;
  readonly verifyCode?: number;
  readonly manifestCode?: number;
  /** Exit code per `bun run <script>`; a script not named here exits 0. */
  readonly scriptCodes?: Readonly<Record<string, number>>;
  /** Findings each guard on disk adds to `boundaries`, by guard name; one not named adds none. */
  readonly guardFindings?: ReadonlyMap<string, number>;
  /** `x verify --only boundaries`' stdout, replacing the count read off disk. */
  readonly boundaries?: string;
  /** `x g guard`'s exit code. */
  readonly generateCode?: number;
  /** `x verify --only unit`'s stdout. */
  readonly unit?: string;
}

/** `boundaries`, as the installed CLI reports it: one finding per break of each guard on disk. */
const boundariesDocument = async (cwd: string, script: Script): Promise<string> => {
  let count = 0;
  for await (const path of new Bun.Glob('guards/*.ts').scan({ cwd })) {
    if (path.endsWith('.test.ts')) continue;
    const name = path.replaceAll('\\', '/').slice('guards/'.length, -'.ts'.length);
    count += script.guardFindings?.get(name) ?? 0;
  }
  const finding = {
    code: 'X_GUARD_FAILED',
    cause: 'a break',
    fix: 'x verify --only boundaries --json',
  };
  return JSON.stringify({
    ok: count === 0,
    steps: [{ name: 'boundaries', ok: count === 0, findings: Array(count).fill(finding) }],
  });
};

/** `x g guard <name>`: the rule and its test, written for real so `git status` and the count see them. */
const generated = async (cwd: string, name: string): Promise<string> => {
  const files = [`guards/${name}.ts`, `guards/${name}.test.ts`];
  await Promise.all(files.map((path) => Bun.write(join(cwd, path), `// ${name}\n`)));
  return JSON.stringify({ ok: true, command: 'g', data: { files } });
};

/** Git runs for real; everything `process.execPath` would run is the script, recorded in order. */
export const recording = (script: Script = {}): { runner: Runner; spawned: string[] } => {
  const spawned: string[] = [];
  const runner: Runner = async (command, options) => {
    if (command[0] === 'git') return exec(command, options);
    expect(command[0]).toBe(process.execPath);
    const args = command.slice(1);
    const only = args[2] === '--only' ? ` --only ${args[3] ?? ''}` : '';
    const label = args[0]?.endsWith('bin.ts') ? `x ${args[1]}${only}` : args.slice(0, 2).join(' ');
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
      case 'x exercise':
        return answer(command, script.exercise ?? EXERCISE_GREEN, script.exerciseCode ?? 0);
      case 'x verify':
        return answer(command, script.verify ?? VERIFY_GREEN, script.verifyCode ?? 0);
      case 'x verify --only boundaries':
        return answer(
          command,
          script.boundaries ?? (await boundariesDocument(options.cwd, script)),
        );
      case 'x verify --only unit':
        return answer(command, script.unit ?? VERIFY_GREEN);
      case 'x g':
        if ((script.generateCode ?? 0) !== 0) return answer(command, '', script.generateCode);
        return answer(command, await generated(options.cwd, args[3] ?? ''));
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
    readonly typescript: readonly {
      file: string;
      field: string;
      from: string;
      to: string;
      fix: string;
    }[];
    readonly guards: {
      readonly reported: boolean;
      readonly missing: readonly { name: string; add: string }[];
      readonly differs: readonly { name: string; refresh: string }[];
      readonly installed: readonly string[];
      readonly withheld: readonly { name: string; add: string; findings: number | null }[];
    } | null;
    readonly coverage: {
      readonly file: string;
      readonly to: { lines: number; funcs: number };
    } | null;
    readonly manifest: { ok: boolean } | null;
    readonly doctorWarnings?: readonly { code: string; cause: string; fix: string }[];
    readonly exercise: {
      readonly reported: boolean;
      readonly ok: boolean;
      readonly findings: readonly { code: string; cause: string; fix: string; at?: string }[];
    } | null;
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

/** One adopter's shape: pins and scripts in the workspaces, and no `app.config.ts` anywhere. */
export const fixtureWithoutApp = async (
  scripts: Readonly<Record<string, string>> = { typecheck: 'tsc', test: 'bun test', lint: 'biome' },
): Promise<string> => {
  const dir = await fixture({
    'package.json': `${JSON.stringify(
      {
        name: 'pinned-app',
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
