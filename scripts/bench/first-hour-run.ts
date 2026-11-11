// The first hour a stranger spends, as data: the published `create-ultimate`, then the scaffold's own
// commands in the order its README gives them, each timed. Pure over an injected runner and sizer,
// so the order, the JSON and a failed step's record are tested without a network or a registry.

import type { ExecResult, Runner } from '@ultimat3/cli';
import { nextCommands } from './first-hour-next';

export interface FirstHourStep {
  readonly name: string;
  readonly command: readonly string[];
  /** `work` is the clean parent directory; `app` is the scaffold inside it. */
  readonly in: 'work' | 'app';
  /**
   * The step whose `--json` verdict names this one's commands (`data.next`): run what the
   * generator told its author to run, never a copy of it. `command` is then empty.
   */
  readonly follows?: string;
}

export interface StepRecord {
  readonly name: string;
  readonly command: string;
  /** `null` when an earlier step failed and this one never ran — never a zero time. */
  readonly ms: number | null;
  readonly status: 'ok' | 'failed' | 'skipped';
  /**
   * Why it failed: every heartbeat line that says `"ok":false`, wherever it sits, then the last
   * lines of output — see `tailOf`.
   */
  readonly tail?: string;
}

/** The bytes and counts a first run leaves behind; a figure that could not be read is `null`. */
export interface FirstHourSizes {
  readonly appFiles: number | null;
  readonly nodeModulesMb: number | null;
  readonly packages: number | null;
  readonly homeBytes: number | null;
  readonly homeJsBytes: number | null;
  readonly imageMb: number | null;
}

export interface FirstHourInput {
  readonly app: string;
  readonly work: string;
  /** `create-ultimate@<version>`: the published tarball, a stranger's path — never a workspace link. */
  readonly version: string;
  readonly image: boolean;
}

/** The steps, in the order the scaffold's README and a stranger's first feature take them. */
export function firstHourSteps(input: FirstHourInput): readonly FirstHourStep[] {
  const create = `create-ultimate@${input.version}`;
  return [
    { name: 'scaffold', in: 'work', command: ['bun', 'x', create, input.app, '--no-git'] },
    { name: 'setup', in: 'app', command: ['bun', 'run', 'setup'] },
    { name: 'verify', in: 'app', command: ['bun', 'run', 'verify', '--json'] },
    {
      name: 'first feature',
      in: 'app',
      command: ['bun', 'x', 'x', 'g', 'resource', 'note', '--json'],
    },
    // `x g resource` writes no migration: its `next` is `x db gen` and `x db migrate`, and a gate
    // run without them is red on a table that does not exist (bench run 42879568783).
    { name: 'feature next steps', in: 'app', command: [], follows: 'first feature' },
    { name: 'setup after feature', in: 'app', command: ['bun', 'run', 'setup'] },
    { name: 'verify after feature', in: 'app', command: ['bun', 'run', 'verify', '--json'] },
    ...(input.image
      ? [
          {
            name: 'image',
            in: 'app' as const,
            command: [
              'docker',
              'build',
              '-f',
              'docker/Dockerfile',
              '-t',
              `${input.app}:bench`,
              '.',
            ],
          },
        ]
      : []),
  ];
}

/** How many lines of output the tail keeps as the general fallback. */
const TAIL_LINES = 5;

/**
 * A gate heartbeat that says this step went red. Parsed, not substringed: `@ultimat3/cli`'s
 * `verify-progress.ts` writes exactly `{"step":"manifest","ok":false,"ms":1234}` per finished step,
 * and a step name, a finding or a fixture carrying those bytes in its text is output, never a
 * verdict.
 */
const failedStepLine = (line: string): boolean => {
  if (!line.startsWith('{"step":"')) return false;
  let heartbeat: unknown;
  try {
    heartbeat = JSON.parse(line);
  } catch {
    return false;
  }
  const step = heartbeat as { step?: unknown; ok?: unknown };
  return typeof step.step === 'string' && step.ok === false;
};

/**
 * The lines a failed step is remembered by. `x verify --json` puts its verdict on stdout while the
 * gate streams one heartbeat line per step to stderr, so the LAST lines of the merged output are
 * whichever steps finished last — never, on a red gate, the one that failed. Every red heartbeat is
 * therefore kept wherever it sits; the last `TAIL_LINES` lines stay as the fallback for a command
 * that prints no heartbeat at all.
 */
const tailOf = (text: string): string => {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const failed = lines.filter(failedStepLine).slice(0, TAIL_LINES);
  const red = new Set(failed);
  return [...failed, ...lines.slice(-TAIL_LINES).filter((line) => !red.has(line))].join(' | ');
};

/** One step's commands, run in order until one fails: their summed time and the last stdout. */
async function runCommands(
  commands: readonly (readonly string[])[],
  cwd: string,
  runner: Runner,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{
  readonly ms: number;
  readonly stdout: string;
  readonly failed?: { readonly argv: string; readonly result: ExecResult };
}> {
  let ms = 0;
  let stdout = '';
  for (const argv of commands) {
    const result = await runner(argv, { cwd, env });
    ms += result.durationMs;
    stdout = result.stdout;
    if (!result.ok) return { ms: Math.round(ms), stdout, failed: { argv: argv.join(' '), result } };
  }
  return { ms: Math.round(ms), stdout };
}

/**
 * Every step in order. The first failure is recorded with the time it actually took, and every
 * step after it as `skipped` with no time: a total over a broken run would be a figure for a
 * first hour that never happened. A step that `follows` another runs the commands that step's
 * verdict named, timed as their sum, and fails under the one that went red.
 */
export async function runFirstHour(
  input: FirstHourInput,
  runner: Runner,
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly StepRecord[]> {
  const records: StepRecord[] = [];
  const stdout = new Map<string, string>();
  let broken = false;
  for (const step of firstHourSteps(input)) {
    const planned =
      step.follows === undefined
        ? { ok: true as const, commands: [step.command] }
        : nextCommands(stdout.get(step.follows) ?? '');
    const command = planned.ok ? planned.commands.map((argv) => argv.join(' ')).join(' && ') : '';
    if (broken) {
      records.push({ name: step.name, command, ms: null, status: 'skipped' });
      continue;
    }
    if (!planned.ok) {
      broken = true;
      records.push({ name: step.name, command, ms: 0, status: 'failed', tail: planned.reason });
      continue;
    }
    const cwd = step.in === 'work' ? input.work : `${input.work}/${input.app}`;
    const ran = await runCommands(planned.commands, cwd, runner, env);
    stdout.set(step.name, ran.stdout);
    if (ran.failed === undefined) {
      records.push({ name: step.name, command, ms: ran.ms, status: 'ok' });
      continue;
    }
    broken = true;
    const tail = tailOf(`${ran.failed.result.stdout}\n${ran.failed.result.stderr}`);
    records.push({ name: step.name, command: ran.failed.argv, ms: ran.ms, status: 'failed', tail });
  }
  return records;
}

/** Green only when every step ran and passed. */
export const firstHourOk = (records: readonly StepRecord[]): boolean =>
  records.length > 0 && records.every((record) => record.status === 'ok');
