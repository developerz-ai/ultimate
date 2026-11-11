// The seed run on the `unit` step: every seed the app declares (`SEED_GLOBS`) runs once, in file
// order, on one in-memory driver. A row its entity refuses — `{ minor: 19.99 }` typechecks — is
// reported with the entity's OWN code and fix, here, instead of 13 s later inside the e2e step's
// X_E2E_APP_FAILED. No seed file is no seeds: nothing is spawned.

import { ERROR_DOCS_URL, UltimateError } from '@ultimat3/core';
import type { Infer } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';
import { SEED_GLOBS } from './db-seed';
import type { Runner } from './exec';
import type { Finding } from './output';
import { findingFrom } from './output';
import { hasPathSegment } from './path-segments';
import { posixRelative } from './posix-path';
import { quoteArg } from './shell-quote';
import { isTest, sortedPosix } from './source-files';

const reportSchema = t.array(
  t.object({
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
type SeedFailure = Infer<typeof reportSchema>[number];

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

/**
 * Run in a CHILD, from the app's root, for `verify-factories.ts`'s reason: the seeds, `isSeed` and
 * `memoryDriver` must be the app's own `@ultimat3/entity`, and the app's entities must not register
 * into this process. One driver for the whole run, so a later seed reads what an earlier one wrote,
 * as `x db seed` does. The last stdout line is the report: the failures only.
 */
const script = (files: readonly string[]): string => `const files = ${JSON.stringify(files)};
const { isSeed, memoryDriver } = await import('@ultimat3/entity');
const driver = memoryDriver();
const str = (value, key) => { try { const v = value?.[key]; return typeof v === 'string' ? v : null; } catch { return null; } };
const failure = (file, name, seed, error) => ({ file, export: name, seed,
  code: str(error, 'code'), cause: str(error, 'cause'), fix: str(error, 'fix'),
  message: str(error, 'message') ?? (() => { try { return String(error); } catch { return 'a value that will not render'; } })() });
const failures = [];
for (const file of files) {
  let mod;
  try { mod = await import(\`\${process.cwd()}/\${file}\`); }
  catch (error) { failures.push(failure(file, '*', '*', error)); continue; }
  for (const [name, value] of Object.entries(mod)) {
    if (!isSeed(value)) continue;
    try { await value.run({ driver }); } catch (error) { failures.push(failure(file, name, value.name, error)); }
  }
}
console.log(JSON.stringify(failures));`;

/**
 * A seed threw something with no code of its own (a `TypeError` in its body, a module that would
 * not import). The fix is the one line that reproduces it with a full stack, on the same in-memory
 * driver the unit step used — the seed's own file, its own export.
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
      cause: `${input.where} threw an uncoded value on the in-memory driver: ${failure.message}`,
      fix: `bun --eval ${quoteArg(call)}`,
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
    failure.export === '*'
      ? `${failure.file} did not import`
      : `seed "${failure.seed}" (${failure.file})`;
  if (failure.code?.startsWith('X_') === true && failure.cause !== null && failure.fix !== null) {
    return {
      code: failure.code,
      cause: `${where} on the in-memory driver: ${failure.cause}`,
      fix: failure.fix,
      docs: ERROR_DOCS_URL,
      at: failure.file,
    };
  }
  return { ...findingFrom(new SeedFailedError({ failure, where })), at: failure.file };
};

/** The child's last stdout line, parsed — or one finding saying the run printed no report. */
function readReport(stdout: string, stderr: string, first: string): readonly SeedFailure[] {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  try {
    return parse(reportSchema, JSON.parse(last));
  } catch {
    const reason = stderr.trim().split('\n').slice(-3).join(' ') || 'no report was printed';
    return [
      { file: first, export: '*', seed: '*', code: null, cause: null, fix: null, message: reason },
    ];
  }
}

/** The seed run's findings for the app at `root`; none when it declares no seed file. */
export async function seedFindings(root: string, runner: Runner): Promise<readonly Finding[]> {
  const files = await seedFiles(root);
  const first = files[0];
  if (first === undefined) return [];
  const result = await runner(['bun', '--eval', script(files)], { cwd: root });
  return readReport(result.stdout, result.stderr, first).map(seedFinding);
}
