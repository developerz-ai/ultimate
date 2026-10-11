// Single responsibility: the refusal `x g action` / `x g mutator` raise when the slice they were
// pointed at has a hand-written `policy.ts` without the exports the generated file imports.
// Declared outside `templates/` (source the CLI emits) and beside nothing else, as
// `generate-feature.ts`'s `FeatureUnknownError` is: `errors.ts` sits at its line ceiling.

import { UltimateError } from '@ultimat3/core';
import { quoteArg } from './shell-quote';

/** Thrown while the files are PLANNED, so nothing is on disk when it is. */
export class SlicePolicyIncompleteError extends UltimateError {
  constructor(input: {
    readonly policy: string;
    readonly feature: string;
    readonly missing: readonly string[];
    readonly kind: 'action' | 'mutator';
  }) {
    super({
      code: 'X_SLICE_POLICY_INCOMPLETE',
      cause: `${input.policy} does not export ${input.missing.join(' or ')}, which the ${input.kind} x g ${input.kind} writes imports from it — the file is hand-written, a generator never edits it, and nothing was written`,
      fix: `x g policy ${quoteArg(input.feature)} --dry-run --json   # shows the policy.ts a generator expects; add ${input.missing.join(' and ')} to ${input.policy}, then run x g ${input.kind} again`,
    });
  }
}
