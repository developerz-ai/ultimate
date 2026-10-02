// A gate step's deadline: the declared number per step class, the `x.verify.json` override, the
// tag every process a step starts carries, and the kill that leaves none of them behind. A hung
// step used to eat the whole CI job timeout and report nothing (#589); now it fails by name.

import { TEST_TYPES } from '@ultimat3/testing';
import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';
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

/** A process the kill found, as it was the moment before it died. */
export interface KilledProcess {
  readonly pid: number;
  /** Its argv, clipped — a `bun test` coordinator's names every file of its batch. */
  readonly command: string;
}

/** A child the step was still waiting on when it expired. */
export interface InFlightRun {
  readonly command: readonly string[];
  /** Everything it had printed before the kill; absent when it did not settle after it. */
  readonly output?: string;
}

/** What a step was doing when its deadline passed — `verify-stalled.ts` turns it into the finding. */
export interface StepExpiry {
  readonly killed: readonly KilledProcess[];
  readonly inFlight: readonly InFlightRun[];
}

/** A killed child's pipes close with it; this is only the bound on a runner that is not `exec`. */
const SETTLE_MS = 2_000;

/**
 * How a `bun test --parallel` worker is told from its coordinator: the flag bun starts each with
 * (probed on 1.4.0). Killing the WORKERS first is what names the stuck file — the coordinator
 * outlives them just long enough to print `✗ <file> (worker crashed: SIGKILL)` for whatever each
 * was holding, in every reporter mode: plain, GitHub Actions' `::group::`, and the failures-only
 * one an agent's shell switches on. A file's own header line cannot do it — bun prints that as
 * results stream, so a file stuck in its third test has one.
 */
const isTestWorker = (command: string): boolean => command.includes(' --test-worker');

/** How long a coordinator gets to say what its workers were holding before it is killed too. */
const CRASH_REPORT_MS = 1_500;

export interface StepGuard {
  /** `runner`, with every child tagged — and refusing to start one once the step has expired. */
  readonly runner: Runner;
  /** Stop the step: no further child starts, every tagged process is killed, and what was in flight is told. */
  expire(): Promise<StepExpiry>;
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
  // Keyed by the promise itself: two batches of one step may run the very same argv.
  const inFlight = new Map<Promise<ExecResult>, readonly string[]>();
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
      const run = runner(command, { ...options, env: { ...options.env, [STEP_TAG_ENV]: value } });
      inFlight.set(run, command);
      try {
        return await run;
      } finally {
        inFlight.delete(run);
      }
    },
    async expire(): Promise<StepExpiry> {
      expired = true;
      // Before the kill: a killed child settles its runner call, which takes it off the map.
      const waiting = [...inFlight];
      const workers = await killTagged(tag, undefined, isTestWorker);
      if (workers.length > 0) {
        await raceDeadline(Promise.allSettled(waiting.map(([run]) => run)), CRASH_REPORT_MS);
      }
      const rest = await killTagged(tag);
      const killed = [...workers, ...rest.filter((one) => workers.every((w) => w.pid !== one.pid))];
      // After it: the kill closed the child's pipes, so its call now resolves with everything it
      // had printed — for `bun test`, the crash line of each file a worker was holding.
      const settled = await Promise.all(
        waiting.map(async ([run, command]): Promise<InFlightRun> => {
          const raced = await raceDeadline(run.then(execOutput), SETTLE_MS).catch(() => undefined);
          return raced === undefined || raced.timedOut
            ? { command }
            : { command, output: raced.value };
        }),
      );
      return { killed, inFlight: settled };
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

const COMMAND_CHARS = 240;

/**
 * A process's argv, read BEFORE it is killed — afterwards there is nothing to read. procfs where
 * there is one, `ps` otherwise; a process that is already gone is named by its pid alone.
 */
async function commandOf(pid: number): Promise<string> {
  let text = await Bun.file(`/proc/${String(pid)}/cmdline`)
    .text()
    .catch(() => '');
  if (text === '') {
    try {
      const ps = Bun.spawn(['ps', '-ww', '-o', 'command=', '-p', String(pid)], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      text = await new Response(ps.stdout).text();
      await ps.exited;
    } catch {
      text = '';
    }
  }
  const line = text.split('\0').join(' ').trim();
  return line.length > COMMAND_CHARS ? `${line.slice(0, COMMAND_CHARS)}…` : line;
}

/**
 * SIGKILL every process carrying `tag`, and sweep again until a pass finds none: a worker can fork
 * between the listing and its own death. Never this process — a nested gate carries the outer tag.
 * Returns the processes it killed, each with the command line it was running.
 */
export async function killTagged(
  tag: string,
  /** The process table. Absent is this platform's: procfs where there is one, `ps` otherwise. */
  list: () => Promise<readonly ProcessEnviron[]> = async () =>
    (await procfsProcesses()) ?? (await psProcesses()),
  /** Kill only the processes whose command line this accepts. Absent kills every tagged one. */
  only?: (command: string) => boolean,
): Promise<readonly KilledProcess[]> {
  const killed = new Map<number, KilledProcess>();
  // Read once per pid and BEFORE the first signal: a worker exits on its own the moment its
  // coordinator dies, and one read between two kills would find it already gone.
  const commands = new Map<number, string>();
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    const processes = await list();
    const tagged = taggedPids(processes, tag).filter((pid) => pid !== process.pid);
    for (const pid of tagged) {
      if (!commands.has(pid)) commands.set(pid, await commandOf(pid));
    }
    const found =
      only === undefined ? tagged : tagged.filter((pid) => only(commands.get(pid) ?? ''));
    const fresh = found.filter((pid) => !killed.has(pid));
    if (found.length === 0) break;
    for (const pid of found) {
      try {
        process.kill(pid, 'SIGKILL');
        if (!killed.has(pid)) killed.set(pid, { pid, command: commands.get(pid) ?? '' });
      } catch {
        // Already gone between the listing and the signal — which is the outcome wanted.
      }
    }
    // A killed process stays listed until it is reaped; nothing NEW on a pass means it is done.
    if (fresh.length === 0) break;
    await Bun.sleep(20);
  }
  return [...killed.values()];
}

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
