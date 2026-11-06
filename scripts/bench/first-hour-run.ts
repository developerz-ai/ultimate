// The first hour a stranger spends, as data: the published `create-ultimate`, then the scaffold's own
// commands in the order its README gives them, each timed. Pure over an injected runner and sizer,
// so the order, the JSON and a failed step's record are tested without a network or a registry.

import type { Runner } from '@ultimat3/cli';

export interface FirstHourStep {
  readonly name: string;
  readonly command: readonly string[];
  /** `work` is the clean parent directory; `app` is the scaffold inside it. */
  readonly in: 'work' | 'app';
}

export interface StepRecord {
  readonly name: string;
  readonly command: string;
  /** `null` when an earlier step failed and this one never ran — never a zero time. */
  readonly ms: number | null;
  readonly status: 'ok' | 'failed' | 'skipped';
  /** The last lines a failed step printed, so the JSON says why. */
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
    { name: 'first feature', in: 'app', command: ['bun', 'x', 'x', 'g', 'resource', 'note'] },
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

const tailOf = (text: string): string =>
  text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-5)
    .join(' | ');

/**
 * Every step in order. The first failure is recorded with the time it actually took, and every
 * step after it as `skipped` with no time: a total over a broken run would be a figure for a
 * first hour that never happened.
 */
export async function runFirstHour(
  input: FirstHourInput,
  runner: Runner,
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly StepRecord[]> {
  const records: StepRecord[] = [];
  let broken = false;
  for (const step of firstHourSteps(input)) {
    const command = step.command.join(' ');
    if (broken) {
      records.push({ name: step.name, command, ms: null, status: 'skipped' });
      continue;
    }
    const cwd = step.in === 'work' ? input.work : `${input.work}/${input.app}`;
    const result = await runner(step.command, { cwd, env });
    const ms = Math.round(result.durationMs);
    if (result.ok) {
      records.push({ name: step.name, command, ms, status: 'ok' });
      continue;
    }
    broken = true;
    const tail = tailOf(`${result.stdout}\n${result.stderr}`);
    records.push({ name: step.name, command, ms, status: 'failed', tail });
  }
  return records;
}

/** Green only when every step ran and passed. */
export const firstHourOk = (records: readonly StepRecord[]): boolean =>
  records.length > 0 && records.every((record) => record.status === 'ok');
