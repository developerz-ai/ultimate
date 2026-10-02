// A gate step's deadline: the declared number per step class, the `x.verify.json` override, the
// tag every process a step starts carries, and the kill that leaves none of them behind. A hung
// step used to eat the whole CI job timeout and report nothing (#589); now it fails by name.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { TEST_TYPES } from '@ultimat3/testing';
import type { ExecResult, Runner } from './exec';
import type { Finding } from './output';
import type { VerifyStepName } from './verify-step';

/** The `x.verify.json` key: `{ "stepTimeoutMs": { "unit": 900000 } }`. */
export const STEP_TIMEOUT_FIELD = 'stepTimeoutMs';

/** A check step — the compiler, biome, an in-process scan. Five minutes. */
export const CHECK_STEP_TIMEOUT_MS = 300_000;

/**
 * A test suite. Eight minutes: under the ten a CI job is commonly given, so the step names itself
 * before the runner cancels the job — the framework's own `unit` step is ~3 on a 4-core runner.
 */
export const SUITE_STEP_TIMEOUT_MS = 480_000;

const SUITE_STEPS: readonly string[] = TEST_TYPES;

export const defaultStepTimeoutMs = (step: string): number =>
  SUITE_STEPS.includes(step) ? SUITE_STEP_TIMEOUT_MS : CHECK_STEP_TIMEOUT_MS;

export type StepTimeouts = Readonly<Partial<Record<VerifyStepName, number>>>;

/** The caller's override, then the floor file's, then the step class's declared number. */
export const stepTimeoutMs = (
  step: VerifyStepName,
  ...overrides: readonly (StepTimeouts | undefined)[]
): number => {
  for (const table of overrides) {
    const ms = table !== undefined && Object.hasOwn(table, step) ? table[step] : undefined;
    if (ms !== undefined) return ms;
  }
  return defaultStepTimeoutMs(step);
};

/**
 * `stepTimeoutMs` out of `x.verify.json`, or the reasons it is not one. A value that is not a
 * positive whole number is refused, never read as "no deadline": a typo that removed the deadline
 * is the hang this file exists to end.
 */
export function readStepTimeouts(
  payload: Record<string, unknown> | undefined,
  declared: readonly string[],
): { timeouts?: StepTimeouts; problems: readonly string[] } {
  const raw = payload?.[STEP_TIMEOUT_FIELD];
  if (raw === undefined) return { problems: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problems: [`"${STEP_TIMEOUT_FIELD}" is not an object of { "<step>": milliseconds }`] };
  }
  const problems: string[] = [];
  const timeouts = new Map<string, number>();
  for (const [step, ms] of Object.entries(raw)) {
    if (!declared.includes(step)) {
      problems.push(`"${STEP_TIMEOUT_FIELD}" names ${step}, which x verify does not run`);
    } else if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms <= 0) {
      problems.push(
        `"${STEP_TIMEOUT_FIELD}" gives ${step} ${JSON.stringify(ms)}, which is not a positive whole number of milliseconds`,
      );
    } else timeouts.set(step, ms);
  }
  return {
    ...(timeouts.size === 0 ? {} : { timeouts: Object.fromEntries(timeouts) as StepTimeouts }),
    problems,
  };
}

/** Carried by every process a step starts, and inherited by everything those start in turn. */
export const STEP_TAG_ENV = 'ULTIMATE_VERIFY_STEP';

/** `bun test`-style "the command was stopped" exit, as `timeout(1)` reports it. */
const EXPIRED_EXIT = 124;

export interface StepGuard {
  /** `runner`, with every child tagged — and refusing to start one once the step has expired. */
  readonly runner: Runner;
  /** Stop the step: no further child starts, and every tagged process is killed. Returns how many. */
  expire(): Promise<number>;
}

/**
 * The step's own view of the subprocess boundary. The tag is an ENVIRONMENT variable rather than a
 * pid list or a process group because it is the one mark a grandchild keeps after its parent dies:
 * `bun test --parallel` workers, `bunx`'s child and an e2e browser are all re-parented to init the
 * moment the process this file started exits, and a walk down the ppid chain loses them there.
 *
 * A nested gate (a test that runs `x verify`) appends its tag to the one it inherited, so the
 * outer step's kill still finds the inner step's children.
 */
export function guardStep(
  runner: Runner,
  tag: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): StepGuard {
  let expired = false;
  const inherited = env[STEP_TAG_ENV];
  const value = inherited === undefined || inherited === '' ? tag : `${inherited} ${tag}`;
  return {
    runner: async (command, options): Promise<ExecResult> => {
      // The step's own code keeps running after its deadline — a batch loop moves on to the next
      // batch when the killed one returns — and a child started then would outlive the gate.
      if (expired) {
        return {
          command,
          code: EXPIRED_EXIT,
          ok: false,
          stdout: '',
          stderr: 'not started: the step is past its deadline',
          durationMs: 0,
        };
      }
      return runner(command, { ...options, env: { ...options.env, [STEP_TAG_ENV]: value } });
    },
    async expire(): Promise<number> {
      expired = true;
      return killTagged(tag);
    },
  };
}

/** One process and the environment it was started with, as the platform reports it. */
export interface ProcessEnviron {
  readonly pid: number;
  /** Whatever text holds `NAME=value` pairs — NUL-separated on Linux, space-separated from `ps`. */
  readonly environ: string;
}

/** The pids whose environment carries `tag` as one word of `STEP_TAG_ENV`'s value. */
export function taggedPids(processes: readonly ProcessEnviron[], tag: string): readonly number[] {
  const marker = `${STEP_TAG_ENV}=`;
  const pids: number[] = [];
  for (const one of processes) {
    for (const pair of one.environ.split('\0')) {
      const at = pair.indexOf(marker);
      if (at < 0) continue;
      // From `ps`, the pair is one line of space-separated pairs: the value runs to the next
      // ` NAME=`, and a tag never holds `=`.
      const value = pair.slice(at + marker.length).split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/)[0] ?? '';
      if (value.split(' ').includes(tag)) pids.push(one.pid);
    }
  }
  return pids;
}

/** Linux: every process's start-time environment is a file. Unreadable ones are not ours. */
async function procfsProcesses(): Promise<readonly ProcessEnviron[] | undefined> {
  if (!(await Bun.file('/proc/self/environ').exists())) return undefined;
  const out: ProcessEnviron[] = [];
  for await (const entry of new Bun.Glob('[0-9]*').scan({ cwd: '/proc', onlyFiles: false })) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid)) continue;
    const environ = await Bun.file(`/proc/${entry}/environ`)
      .text()
      .catch(() => undefined);
    if (environ !== undefined) out.push({ pid, environ });
  }
  return out;
}

/**
 * Elsewhere (macOS, BSD): `ps` in its BSD spelling — `e` prints each process's environment after
 * its command, `ww` never truncates it. The same spelling answers on Linux, which is where it is
 * tested; procfs is preferred there because it needs no process and no parsing.
 */
export async function psProcesses(): Promise<readonly ProcessEnviron[]> {
  try {
    const ps = Bun.spawn(['ps', 'axeww', '-o', 'pid=,command='], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = await new Response(ps.stdout).text();
    await ps.exited;
    return text.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match === null ? [] : [{ pid: Number(match[1]), environ: match[2] ?? '' }];
    });
  } catch {
    return [];
  }
}

const SWEEPS = 5;

/**
 * SIGKILL every process carrying `tag`, and sweep again until a pass finds none: a worker can fork
 * between the listing and its own death. Never this process — a nested gate carries the outer tag.
 */
export async function killTagged(
  tag: string,
  /** The process table. Absent is this platform's: procfs where there is one, `ps` otherwise. */
  list: () => Promise<readonly ProcessEnviron[]> = async () =>
    (await procfsProcesses()) ?? (await psProcesses()),
): Promise<number> {
  const killed = new Set<number>();
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    const processes = await list();
    const found = taggedPids(processes, tag).filter((pid) => pid !== process.pid);
    const fresh = found.filter((pid) => !killed.has(pid));
    if (found.length === 0) break;
    for (const pid of found) {
      try {
        process.kill(pid, 'SIGKILL');
        killed.add(pid);
      } catch {
        // Already gone between the listing and the signal — which is the outcome wanted.
      }
    }
    // A killed process stays listed until it is reaped; nothing NEW on a pass means it is done.
    if (fresh.length === 0) break;
    await Bun.sleep(20);
  }
  return killed.size;
}

/**
 * A step that ran past its deadline, on that step's own line. `command` is the gate as it was
 * invoked here (`x verify`, or `bun run verify` at the framework root), so the fix runs where the
 * finding was raised.
 */
export const stepTimeoutFinding = (
  step: VerifyStepName,
  ms: number,
  killed: number,
  command: string,
): Finding => ({
  code: 'X_VERIFY_STEP_TIMEOUT',
  cause: `step "${step}" did not finish within its ${String(ms)} ms deadline, so it was stopped and ${String(killed)} process(es) it had started were killed`,
  fix: `${command} --only ${step} --json   # reproduce it alone; if it legitimately needs longer, edit x.verify.json — add "${STEP_TIMEOUT_FIELD}": { "${step}": <milliseconds> }`,
  docs: ERROR_DOCS_URL,
});

/** `work`, or `{ timedOut: true }` once `ms` passes. The abandoned promise is never unhandled. */
export async function raceDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ readonly timedOut: false; readonly value: T } | { readonly timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<{ readonly timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    const raced = await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      expired,
    ]);
    if (raced.timedOut) work.catch(() => undefined);
    return raced;
  } finally {
    clearTimeout(timer);
  }
}
