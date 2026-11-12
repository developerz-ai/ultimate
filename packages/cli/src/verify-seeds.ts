// The seed run on the `unit` step: every seed the app declares (`SEED_GLOBS`) runs once, in file
// order, on one migrated scratch database. A row its entity refuses — `{ minor: 19.99 }`
// typechecks — is reported with the entity's OWN code and fix, here, instead of 13 s later inside
// the e2e step's X_E2E_APP_FAILED. No seed file is no seeds: nothing is spawned.

// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { ERROR_DOCS_URL, UltimateError } from '@ultimat3/core';
import type { Infer } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';
import { SEED_GLOBS } from './db-seed';
import type { Runner } from './exec';
import { MIGRATIONS_DIR } from './migrations';
import type { Finding } from './output';
import { findingFrom } from './output';
import { hasPathSegment } from './path-segments';
import { posixRelative } from './posix-path';
import { quoteArg } from './shell-quote';
import { isTest, sortedPosix } from './source-files';

/** Where a failure happened: the seed run's database, a seed module's import, or a seed's run. */
const SEED_STAGES = ['database', 'import', 'run'] as const;
export type SeedStage = (typeof SEED_STAGES)[number];

const reportSchema = t.array(
  t.object({
    stage: t.enum(SEED_STAGES),
    file: t.string,
    /** The export that declared the seed; `*` when the module would not import. */
    export: t.string,
    seed: t.string,
    code: t.nullable(t.string),
    cause: t.nullable(t.string),
    fix: t.nullable(t.string),
    message: t.string,
  }),
);
export type SeedFailure = Infer<typeof reportSchema>[number];

/** The seed files `x db seed` would import, app-root-relative and sorted: the run's order. */
async function seedFiles(root: string): Promise<readonly string[]> {
  const files = new Set<string>();
  for (const pattern of SEED_GLOBS) {
    for await (const absolute of new Bun.Glob(pattern).scan({ cwd: root, absolute: true })) {
      const file = posixRelative(root, absolute);
      if (hasPathSegment(absolute, 'node_modules') || isTest(file)) continue;
      files.add(file);
    }
  }
  return sortedPosix([...files]);
}

/** The line the probe prints its answer on; everything else it writes is a seed's own output. */
export const SEEDS_PROBE_MARKER = 'x-seeds-probe:';

/**
 * Run in a CHILD, from the app's root (`verify-seeds-probe.ts`): the app's entities must not
 * register into this process, and the scratch database the probe installs as `db()` must not be
 * this process's either. One database for the whole run, so a later seed reads what an earlier one
 * wrote, as `x db seed` does.
 */
const PROBE = join(import.meta.dir, 'verify-seeds-probe.ts');

/**
 * A seed threw something with no code of its own (a `TypeError` in its body, a module that would
 * not import, a scratch database that would not open). The fix is the one line that reproduces it with a full stack — the seed's own file,
 * its own export.
 */
export class SeedFailedError extends UltimateError {
  constructor(input: { failure: SeedFailure; where: string }) {
    const { failure } = input;
    const call =
      failure.export === '*'
        ? `await import('./${failure.file}')`
        : `await (await import('./${failure.file}'))[${JSON.stringify(failure.export)}].run()`;
    super({
      code: 'X_SEED_FAILED',
      cause: `${input.where} threw an uncoded value: ${failure.message}`,
      // The database is `x exercise`'s own, opened the same way: that command reproduces it.
      fix: failure.stage === 'database' ? 'x exercise --json' : `bun --eval ${quoteArg(call)}`,
    });
  }
}

/**
 * The inner error, at the top level: a coded refusal keeps its code and its fix verbatim — the
 * entity's fix is the one that names the edit — and only the cause gains which seed and file.
 * An uncoded throw has no fix of its own, so the fix is the line that reproduces it with a stack.
 */
export const seedFinding = (failure: SeedFailure): Finding => {
  const where =
    failure.stage === 'database'
      ? `the seed run's scratch database (the framework schema, then ${MIGRATIONS_DIR}) did not open`
      : failure.stage === 'import'
        ? `${failure.file} did not import`
        : `seed "${failure.seed}" (${failure.file}) on the seed run's scratch database`;
  if (failure.code?.startsWith('X_') === true && failure.cause !== null && failure.fix !== null) {
    return {
      code: failure.code,
      cause: `${where}: ${failure.cause}`,
      fix: failure.fix,
      docs: ERROR_DOCS_URL,
      at: failure.file,
    };
  }
  return { ...findingFrom(new SeedFailedError({ failure, where })), at: failure.file };
};

/** The probe's marker line, parsed — or one finding saying the run printed no report. */
function readReport(stdout: string, stderr: string, first: string): readonly SeedFailure[] {
  const line = stdout
    .split('\n')
    .reverse()
    .find((one) => one.startsWith(SEEDS_PROBE_MARKER));
  try {
    return parse(reportSchema, JSON.parse(line?.slice(SEEDS_PROBE_MARKER.length) ?? ''));
  } catch {
    const reason = stderr.trim().split('\n').slice(-3).join(' ') || 'no report was printed';
    return [
      {
        stage: 'import',
        file: first,
        export: '*',
        seed: '*',
        code: null,
        cause: null,
        fix: null,
        message: reason,
      },
    ];
  }
}

/** The seed run's findings for the app at `root`; none when it declares no seed file. */
export async function seedFindings(root: string, runner: Runner): Promise<readonly Finding[]> {
  const files = await seedFiles(root);
  const first = files[0];
  if (first === undefined) return [];
  const result = await runner(['bun', PROBE, root, JSON.stringify(files)], { cwd: root });
  return readReport(result.stdout, result.stderr, first).map(seedFinding);
}
