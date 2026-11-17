// The order rule on a `fix:` line, for the `errors` step: the edit leads, the re-run follows —
// `x verify   # after deleting .sensitive()` is pasted before it is read, and re-runs unchanged.
// Shipped lines are ratcheted per file in `FIX_SEQUENCE_BASELINE`; a new one is
// `X_ERROR_FIX_INVALID`. A generator or scaffolder offered with `--force` is never a fix (none shipped 2026-11).

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

/**
 * `x g …` / `x generate …` / `x new …` / `create-ultimate …` carrying `--force`, before any `#`
 * comment: the part that is pasted. The scaffolders are generators too — `x new … --force` over an
 * existing app reset its `roles.ts` to the template (D1).
 */
const FORCED_GENERATOR =
  /(?:^|[\s;|&(])(?:x\s+(?:g|generate|new)|create-ultimate)\b[^#]*?\s--force(?![\w-])/;

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

/** A quoted `--force` token, whole: `'--force-with-lease'` is another flag. */
const QUOTED_FORCE = /(['"`])--force\1/;

/**
 * The same rule on the RAW fix, inside its interpolations: `${[invocation, name, '--force'].join(' ')}`
 * blanks to `<value>`, so the text rule above never saw the `--force` that `x new` printed (D1).
 * Two `indexOf` scans, as `staticFix` does — no regex re-scanning from every unclosed `${`.
 */
export function interpolatedForceProblem(raw: string): string | undefined {
  for (let open = raw.indexOf('${'); open >= 0; ) {
    const close = raw.indexOf('}', open + 2);
    if (close < 0) return undefined;
    if (QUOTED_FORCE.test(raw.slice(open + 2, close))) {
      return `fix "${raw}" assembles --force into the command it prints, which overwrites what the target already holds, and a pasted fix shows no diff first — name a free target or the edit instead`;
    }
    open = raw.indexOf('${', close + 1);
  }
  return undefined;
}

/**
 * Root-relative file → how many fix lines in it the rule above refuses: 53 lines in 38 files across
 * this repo and its three tracked apps, measured 2026-11-11 (the docs site's
 * `packages/docs-source/src/errors.ts` is the one app entry). A file at or under its count passes;
 * one past it, or any file not listed — every app's — is a finding at each of its refused lines.
 * Held EQUAL to the step's counts by `fix-sequence.test.ts`: rewrite a line, lower its entry.
 * 2026-11-16 (sweep 8b-4): 30 lines in 23 files — `scripts/` rewritten edit-first, none left.
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
  ['packages/jobs/src/subject-errors.ts', 1],
  ['packages/mail/src/preview-check.ts', 1],
  ['packages/mcp/src/meta-errors.ts', 1],
  ['packages/mcp/src/remote-errors.ts', 1],
  ['packages/schema/src/sensitive.ts', 1],
  ['packages/seo/src/errors.ts', 1],
  ['packages/testing/src/exercise-override-input.ts', 1],
  ['packages/testing/src/plan-sweep-report.ts', 4],
]);
