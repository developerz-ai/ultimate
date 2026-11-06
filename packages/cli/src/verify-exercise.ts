// The `exercise` gate step: `x exercise --json` as a child under the step's deadline, its findings
// the step's. A child, never in process: the pass freezes the clock, seals the network and installs
// its own database, and the steps beside it in this process must see none of that.

// why: Bun has no directory probe for the app config, and no path joiner.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG_FILE, ERROR_DOCS_URL, isCompiledBundle } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { execOutput } from './exec';
import type { Finding } from './output';
import { documentIn } from './upgrade-gate';
import type { VerifyStep } from './verify-step';

/** `x exercise`'s argv, spawned as this process's own CLI: the source entry, or a compiled binary. */
export function verifyExerciseCommand(): readonly string[] {
  const self = isCompiledBundle(import.meta.dir) ? [] : [join(import.meta.dir, 'bin.ts')];
  return [process.execPath, ...self, 'exercise', '--json'];
}

const FINDING = t.object({
  code: t.string,
  cause: t.string,
  fix: t.string,
  docs: t.optional(t.string),
  at: t.optional(t.string),
});
const DOCUMENT = t.object({ ok: t.boolean, findings: t.optional(t.array(FINDING)) });

interface ExerciseDocument {
  readonly ok: boolean;
  readonly findings?: readonly Finding[];
}

export const exerciseStep: VerifyStep = {
  name: 'exercise',
  summary: 'every action, query and job runs once against seeded rows, with no test written',
  // A repo with no `app.config.ts` registers no primitive: SKIPPED, for the reason `policy` gives.
  applies: async (ctx) => existsSync(join(ctx.root, APP_CONFIG_FILE)),
  async run(ctx) {
    const result = await ctx.runner(verifyExerciseCommand(), { cwd: ctx.root });
    const parsed = DOCUMENT.safeParse(documentIn(result.stdout));
    const document = parsed.issues === undefined ? (parsed.value as ExerciseDocument) : undefined;
    const reported = document?.findings ?? [];
    // The exit code is the verdict, as `fromExec` reads every child's; the document adds the
    // findings, and a document that says red is red whatever the exit. A red with nothing to say
    // is still red, under the code for a CLI that failed without saying why.
    if (result.ok && document?.ok !== false && reported.length === 0) {
      return { ok: true, findings: [], output: execOutput(result) };
    }
    const findings: readonly Finding[] =
      reported.length > 0
        ? reported
        : [
            {
              code: 'X_CLI_UNEXPECTED',
              cause: `x exercise --json exited ${String(result.code)} with no finding, so x verify could not say which primitive failed`,
              fix: 'x exercise --json',
              docs: ERROR_DOCS_URL,
            },
          ];
    return { ok: false, findings, output: execOutput(result) };
  },
};
