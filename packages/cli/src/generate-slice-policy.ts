// Single responsibility: the refusal `x g action` / `x g mutator` raise when the slice they were
// pointed at has a hand-written `policy.ts` without the exports the generated file imports.
// Declared outside `templates/` (source the CLI emits) and beside nothing else, as
// `generate-feature.ts`'s `FeatureUnknownError` is: `errors.ts` sits at its line ceiling.

import { UltimateError } from '@ultimat3/core';

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
      // The fix IS the edit: `x g policy --dry-run` prints a write plan, never the source to copy.
      fix: `${input.missing.map((name) => exportLine(name, input.feature)).join(' ')}   # add to ${input.policy} (tag from @ultimat3/cache, can from @ultimat3/policy; the permission must be one its definePermissions() declares), then run x g ${input.kind} again`,
    });
  }
}

/** The export line a scaffolded `policy.ts` carries for `name`. */
const exportLine = (name: string, feature: string): string =>
  name.endsWith('Tag')
    ? `export const ${name} = tag('${feature}');`
    : `export const ${name} = can('${feature}:write');`;
