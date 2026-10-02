// What every `x jobs` test file drives the command with: an app root that exists, an ambient
// memory driver `withJobDriver` reuses instead of booting a queue, and one enqueued job. Shared by
// `cmd-jobs.test.ts` and `cmd-jobs-operator.test.ts`, split at the file-size ceiling.

// why: Bun has no mkdtemp, and Bun.write is async in these synchronous fixture helpers.
import { mkdtempSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { JobDriver } from '@ultimat3/jobs';
import { setJobDriver } from '@ultimat3/jobs';
import { REQUIRED_BUN } from './app-root';
import { jobsCommand } from './cmd-jobs';
import type { CommandContext } from './command';
import type { CommandResult } from './output';

export interface RunOptions {
  readonly subcommand?: string;
  readonly positionals?: readonly string[];
  readonly flags?: Readonly<Record<string, string | boolean>>;
  readonly env?: Readonly<Record<string, string>>;
}

export function appRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-jobs-'));
  writeFileSync(join(dir, 'app.config.ts'), 'export const config = {};\n');
  return dir;
}

export const contextFor = (root: string, options: RunOptions): CommandContext => ({
  args: {
    command: 'jobs',
    subcommand: options.subcommand,
    positionals: [...(options.positionals ?? [])],
    flags: new Map(Object.entries(options.flags ?? {})),
    json: false,
    help: false,
    passthrough: [],
  },
  cwd: root,
  runner: () =>
    Promise.resolve({
      command: ['true'],
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    }),
  env: options.env ?? {},
  bunVersion: REQUIRED_BUN,
});

/** Install the driver `withJobDriver` must reuse, so no command under test boots a second queue. */
export function runJobs(driver: JobDriver, options: RunOptions = {}): Promise<CommandResult> {
  setJobDriver(driver);
  return jobsCommand.run(contextFor(appRoot(), options));
}

export async function enqueue(driver: JobDriver, name: string, runAt?: number): Promise<string> {
  const { id } = await driver.enqueue({
    name,
    queue: 'default',
    input: {},
    idempotencyKey: crypto.randomUUID(),
    maxAttempts: 3,
    ...(runAt === undefined ? {} : { runAt }),
  });
  return id;
}
