// The modules a feature slice owns — `entity.ts`, `repo.ts`, `policy.ts`, `errors.ts` — composed by
// every generator that imports one. `x g resource` already wrote them by composing `entityFiles` +
// `policyFiles`; the five generators that write *into* a slice imported the same files and wrote
// none of them, so each emitted TS2307 in any slice a resource had not been run in first.

import type { FeatureTarget } from './entity';
import { entityFiles } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { policyFiles } from './policy';

/**
 * Which slice modules a generator's own source imports. Named per generator rather than emitted as
 * one fixed set: a job imports `../repo` and evaluates no policy, and a generated `policy.ts` it
 * never reads is a file an author has to read before deleting.
 *
 * `'entity'` is the pair, not the file: `repo.ts` imports `./entity` for its row type, so emitting
 * one without the other moves the unresolved import rather than closing it.
 */
export type SliceModule = 'entity' | 'policy' | 'errors';

/** The feature's own code, derived once. */
const notFoundCode = (feature: NameSet): string =>
  `X_${feature.kebab.toUpperCase().split('-').join('_')}_NOT_FOUND`;

/**
 * The emitted `fix:` cites `x queries list`, and which command it cites is the whole point: a
 * scaffolded app runs the same `errors` step this repo does, so a fix naming a command the build
 * does not ship writes a fresh X_ERROR_FIX_INVALID into the app on every `x g action`. It cited
 * `x db studio`, which is in `PLANNED_SUBCOMMANDS` and exits X_NOT_IMPLEMENTED — the generator was
 * breaking the one rule it exists to demonstrate. `x queries list` ships, and a read is where a
 * caller gets an id that exists.
 */
const errorsSource = (feature: NameSet): string => {
  const errorCode = notFoundCode(feature);
  return `// The ${feature.kebab} feature's X_* codes. Never throw a bare Error: an agent reading the failure
// needs the code, the cause and the exact command that fixes it.

import { UltimateError } from '@ultimat3/core';

// No \`docs:\`. \`UltimateError\` resolves it from the code's registered descriptor, so the link has
// one home; a per-code URL written here is a page that does not exist.
export class ${feature.pascal}NotFoundError extends UltimateError {
  constructor(input: { id: string }) {
    super({
      code: '${errorCode}',
      cause: \`no ${feature.kebab} with id \${input.id}\`,
      fix: 'x queries list --json, then pass an id the ${feature.kebab} read returns',
    });
  }
}
`;
};

/**
 * Re-tags a slice module as one the writer may skip. The byte-carrying variant is passed through
 * untouched rather than cast: only the scaffolded app icon carries bytes and no slice module is a
 * PNG, so a future one would be a visible hard write instead of a silent claim it was checked.
 */
const ifAbsent = (files: readonly GeneratedFile[]): readonly GeneratedFile[] =>
  files.map((file) =>
    typeof file.contents === 'string'
      ? { path: file.path, contents: file.contents, merge: 'if-absent' as const }
      : file,
  );

/**
 * The slice modules `needs` names, in the order a reader meets them: the table, then the authz,
 * then the failures. Named from `target.feature` and never from the primitive's own name — the
 * generated `import { InvoiceNotFoundError } from '../errors'` is the feature's type, not
 * `send-invoice`'s.
 */
export function sliceFoundation(
  target: FeatureTarget,
  needs: readonly SliceModule[],
): readonly GeneratedFile[] {
  const feature = names(target.feature);
  const dir = `${target.surfaceDir}/${target.feature}`;
  return ifAbsent([
    ...(needs.includes('entity') ? entityFiles(target.feature, target) : []),
    ...(needs.includes('policy') ? policyFiles(target.feature, target) : []),
    ...(needs.includes('errors')
      ? [{ path: `${dir}/errors.ts`, contents: errorsSource(feature) }]
      : []),
  ]);
}
