// The order rule on a `fix:` line, for the `errors` step: the edit leads, the re-run follows —
// `x verify   # after deleting .sensitive()` is pasted before it is read, and re-runs unchanged.
// Shipped lines are ratcheted per file in `FIX_SEQUENCE_BASELINE`; a new one is
// `X_ERROR_FIX_INVALID`. A generator offered with `--force` is never a fix (none shipped 2026-11).

/**
 * A comment opening with the precondition, in its deferred-edit form only: `<command>   # after
 * editing …` (a gerund, a call, or an interpolated edit) or `# once … is repaired` (a past
 * participle). A `#` glued to a word is a URL fragment (`…/Upgrading#after-31`), and `# once per
 * environment` / `# once, at boot` is a frequency — neither is refused.
 */
const DEFERRED_EDIT =
  /(?:^|\s)#\s+(?:(after)\s+(?:\w+ing\b|[\w.$]+\(|<value>)|(once)\s+(?!(?:per|only|a|an|each|every|more)\b)[^#,]*?\b\w+ed\b)/i;

/**
 * A line whose whole instruction is to run the failing command again: an optional "fix the
 * failure / cause / error, then", the re-run, and nothing it names to change.
 */
const RERUN_ONLY =
  /^\s*(?:(?:fix|resolve|address|correct|repair)\b[^,.;#]*\b(?:cause|failure|error|problem)\b[^,.;#]*[,;]?\s*(?:then|and)\s+)?(?:re-?run|retry|run (?:it |this )?again)(?:\s+(?:it|this|the command|this command))?\s*\.?\s*$/i;

/**
 * The rule, on one fix line — already `staticFix`ed by the caller, as every rule of the step reads
 * it. `undefined` means the line leads with what to change.
 */
export function fixSequenceProblem(fix: string): string | undefined {
  const deferred = DEFERRED_EDIT.exec(fix);
  if (deferred !== null) {
    return `fix "${fix}" opens with the command and defers the edit to "# ${deferred[1] ?? deferred[2]} …", so the line pasted first re-runs the failure unchanged — lead with the edit, then the command`;
  }
  if (RERUN_ONLY.test(fix)) {
    return `fix "${fix}" only says to re-run, and names no edit, call or file that would make the re-run pass`;
  }
  return undefined;
}

/** `x g …` / `x generate …` carrying `--force`, before any `#` comment: the part that is pasted. */
const FORCED_GENERATOR = /(?:^|[\s;|&(])x\s+(?:g|generate)\b[^#]*?\s--force(?![\w-])/;

/**
 * A printed fix is pasted with no diff in front of it, and a generator's file can be shared — a
 * slice's `policy.ts` holds every permission its generators wrote, and `x g policy … --force`
 * replaced the first with the second (FX2). Prose behind the `#` is not pasted, so it is not read.
 */
export function generatorForceProblem(fix: string): string | undefined {
  const runnable = fix.split(/\s#\s/)[0] ?? '';
  if (!FORCED_GENERATOR.test(runnable)) return undefined;
  return `fix "${fix}" runs a generator with --force, which overwrites a file other slices or generators may share, and a pasted fix shows no diff first — name the edit to the existing file instead`;
}

/**
 * Root-relative file → how many fix lines in it the rule above refuses: 53 lines in 38 files across
 * this repo and its three tracked apps, measured 2026-11-11 (the docs site's
 * `packages/docs-source/src/errors.ts` is the one app entry). A file at or under its count passes;
 * one past it, or any file not listed — every app's — is a finding at each of its refused lines.
 * Held EQUAL to the step's counts by `fix-sequence.test.ts`: rewrite a line, lower its entry.
 */
export const FIX_SEQUENCE_BASELINE: ReadonlyMap<string, number> = new Map([
  ['packages/cli/src/cmd-client-customer.ts', 1],
  ['packages/cli/src/cmd-deploy-preflight.ts', 1],
  ['packages/cli/src/cmd-env-init.ts', 1],
  ['packages/cli/src/handle-registration.ts', 1],
  ['packages/cli/src/job-registration.ts', 1],
  ['packages/cli/src/package-boundaries.ts', 1],
  ['packages/cli/src/upgrade-plan.ts', 1],
  ['packages/cli/src/verify-drift-owner.ts', 1],
  ['packages/core/src/define-error.ts', 1],
  ['packages/core/src/errors.ts', 1],
  ['packages/db/src/drift-triggers.ts', 1],
  ['packages/db/src/generate-partition.ts', 2],
  ['packages/db/src/lifecycle-errors.ts', 1],
  ['packages/db/src/primary-key.ts', 1],
  ['packages/docs-source/src/errors.ts', 4],
  ['packages/entity/src/counter.ts', 1],
  ['packages/entity/src/partition.ts', 1],
  ['packages/entity/src/retain.ts', 1],
  ['packages/jobs/src/subject-errors.ts', 1],
  ['packages/mail/src/preview-check.ts', 1],
  ['packages/mcp/src/meta-errors.ts', 1],
  ['packages/mcp/src/remote-errors.ts', 1],
  ['packages/schema/src/sensitive.ts', 1],
  ['packages/seo/src/errors.ts', 1],
  ['packages/testing/src/exercise-override-input.ts', 1],
  ['packages/testing/src/plan-sweep-report.ts', 4],
  ['scripts/adapter-ports.ts', 4],
  ['scripts/bench-claims.ts', 1],
  ['scripts/budget-raises.ts', 1],
  ['scripts/declaration-readers-callers.ts', 2],
  ['scripts/factory-names.ts', 2],
  ['scripts/instrument-slots.ts', 1],
  ['scripts/lib/export-all.ts', 1],
  ['scripts/new-error-code.ts', 1],
  ['scripts/plan-status.ts', 3],
  ['scripts/posix-relative.ts', 1],
  ['scripts/set-cookie-literals.ts', 2],
  ['scripts/sql-export-readers.ts', 1],
]);
