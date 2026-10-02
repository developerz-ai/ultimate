// The modules a feature slice owns — `entity.ts`, `repo.ts`, `policy.ts`, `errors.ts` — composed by
// every generator that imports one. `x g resource` already wrote them by composing `entityFiles` +
// `policyFiles`; the five generators that write *into* a slice imported the same files and wrote
// none of them, so each emitted TS2307 in any slice a resource had not been run in first.

import { stripComments } from '@ultimat3/core';
import { adminCatalogFiles } from './admin-catalog';
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
  /** Every locale the planted entity's admin labels ship for. Defaults to `['en']`. */
  locales?: readonly string[],
): readonly GeneratedFile[] {
  const feature = names(target.feature);
  const dir = `${target.surfaceDir}/${target.feature}`;
  return [
    ...ifAbsent([
      ...(needs.includes('entity') ? entityFiles(target.feature, target) : []),
      ...(needs.includes('policy') ? policyFiles(target.feature, target) : []),
      ...(needs.includes('errors')
        ? [{ path: `${dir}/errors.ts`, contents: errorsSource(feature) }]
        : []),
    ]),
    // A planted entity joins the typed handle, and an entity in the handle IS an admin screen —
    // so it gets the labels `x g entity` writes for one, or its nav entry renders a missing-key
    // marker. A catalog MERGE, never `if-absent`: a key already there keeps the value it has.
    ...(needs.includes('entity') ? adminCatalogFiles(target.feature, target, locales) : []),
  ];
}

/** The exported names an `export { a, b as c }` list declares — `c`, never `b`. */
const listedExports = (code: string): readonly string[] =>
  [...code.matchAll(/\bexport\s*\{([^}]*)\}/g)].flatMap((match) =>
    (match[1] ?? '')
      .split(',')
      .map(
        (entry) =>
          entry
            .trim()
            .split(/\s+as\s+/)
            .at(-1)
            ?.trim() ?? '',
      )
      .filter((entry) => entry !== ''),
  );

/**
 * Whether `source` — a slice module as it stands on the app's disk — exports the VALUE `name`.
 * Read at generation time because assuming it was measured: `x g action` into ai-maxxing's
 * `fleet` slice wrote `import { FleetNotFoundError } from '../errors'` into a slice whose
 * `errors.ts` declared `HostNotFoundError` and `SessionNotFoundError` and no `FleetNotFoundError`.
 * The file failed at import — and because `x db gen` and `x manifest` load every module, one
 * generated-and-not-yet-edited action made both refuse to run.
 *
 * Comments are masked first: `// TODO: add FleetNotFoundError` is not an export. A `type` or an
 * `interface` of that name is not one either — the generated code constructs it.
 */
export function sliceExports(source: string, name: string): boolean {
  const code = stripComments(source);
  // `(?:async\s+)?` before `function`: an `export async function byId` — every repo function
  // `x g entity` scaffolds — matched neither this nor `listedExports`, so a caller checking for
  // `byId`/`list` on a real repo.ts always read `false`. `async` has no meaning before
  // `class`/`const`/`let`/`var`/`enum`, so it is scoped to `function` only.
  const declared = new RegExp(
    `\\bexport\\s+(?:abstract\\s+)?(?:class|const|let|var|(?:async\\s+)?function|enum)\\s+${name}\\b`,
  );
  return declared.test(code) || listedExports(code).includes(name);
}

/** `    title: text({ max: 200 }),` — one column of an entity, as its name and its builder. */
const COLUMN_LINE = /^ {4}([A-Za-z_$][\w$]*): ([A-Za-z_$][\w$]*)\(/gm;

const columnsOf = (entitySource: string): string =>
  [...stripComments(entitySource).matchAll(COLUMN_LINE)]
    .map((match) => `${match[1] ?? ''}: ${match[2] ?? ''}`)
    .join(', ');

/**
 * Whether a generated TEST may store a row in this slice: its entity declares exactly the columns
 * `x g entity` scaffolds for this feature — read off the entity this generator would write, never
 * a second list — and its `repo.ts`, when one is on disk, still exports `insert`. A slice an author
 * reshaped has a row this generator cannot spell (one more required column is enough), so its
 * tests assert the branches that need none and leave the stored-row case to the author.
 */
export function sliceTakesScaffoldRow(
  target: FeatureTarget,
  sliceEntity: string | undefined,
  sliceRepo: string | undefined,
): boolean {
  if (sliceEntity === undefined) return false;
  const scaffold = entityFiles(target.feature, target).find((file) =>
    file.path.endsWith('/entity.ts'),
  );
  const wanted = columnsOf(String(scaffold?.contents ?? ''));
  if (wanted === '' || columnsOf(sliceEntity) !== wanted) return false;
  return sliceRepo === undefined || sliceExports(sliceRepo, 'insert');
}
