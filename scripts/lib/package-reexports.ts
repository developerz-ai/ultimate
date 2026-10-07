// No package publishes a value another `@ultimat3/*` package exports, in any spelling: a re-export
// is a second import path for one value, and an agent picks one at random (axiom 1). The values are
// every entry's real exports (`package-entries.ts`), never a hand list. Run by `bun run flight-copies`.

import type { Finding } from './log';
import { entryFor, homeOf, isPackageValue, packageOfPath } from './package-entries';
import { type Reexport, reexportsIn } from './reexport-scan';
import { lineOf } from './source-scan';

export interface ReexportExemption {
  /** The file that re-exports, repo-relative. */
  readonly at: string;
  /** The value's name in `from`. */
  readonly name: string;
  readonly from: string;
  /** The argument for a second path — a sentence, never "convenient". */
  readonly why: string;
}

/** What a re-export is pinned by: the file, the source entry and the value's name there. */
export const reexportKey = (at: string, from: string, name: string): string =>
  `${at}#${from}:${name}`;

/**
 * `t` is the declaration vocabulary: every primitive file is written in it beside the factory it
 * declares with, so the primitive barrel carrying it makes ONE import per primitive file — the
 * documented design (`CLAUDE.md`, `packages/action/src/index.ts`). The same value, never a copy.
 */
const T_VOCABULARY =
  "schema's `t` is the declaration vocabulary every primitive file is written in, so the primitive's barrel carries it and a primitive file is one import — the documented design in CLAUDE.md and packages/action/src/index.ts";

const T_BARRELS = ['action', 'ai', 'entity', 'jobs', 'mail', 'mcp', 'notify', 'query'];

/**
 * Each row is a second path that stands, with its argument. Held both ways by tests: a row the tree
 * no longer has is a failure (`flight-copies.test.ts`), so a fixed site deletes its row in the same
 * change. Never add a row to make the gate green — delete the re-export and repoint its callers.
 */
export const PACKAGE_REEXPORT_EXEMPT: readonly ReexportExemption[] = [
  ...T_BARRELS.map(
    (pkg): ReexportExemption => ({
      at: `packages/${pkg}/src/index.ts`,
      name: 't',
      from: '@ultimat3/schema',
      why: T_VOCABULARY,
    }),
  ),
  {
    at: 'packages/core/src/error-render.ts',
    name: 'describeValue',
    from: '@ultimat3/schema',
    why: "core's render helpers are what every `cause:` is built with, and db, storage, flags, testing, cli and jobs reach them through core, which several of them depend on alone; the one implementation is schema's, over the declared core -> schema edge",
  },
  {
    at: 'packages/core/src/iso-date.ts',
    name: 'isIsoDateTime',
    from: '@ultimat3/schema',
    why: 'ui and flags judge a date string and depend on core, not schema: the ONE rule `t.date` and `timestamp()` use reaches them over the declared core -> schema edge instead of a second copy of it',
  },
];

const EXEMPT: ReadonlySet<string> = new Set(
  PACKAGE_REEXPORT_EXEMPT.map((row) => reexportKey(row.at, row.from, row.name)),
);

/**
 * A `*-fixture.ts` is never published — every manifest's `files` negates it and `package-shape`
 * refuses an entry that reaches one — so it is no import path, whatever it exports.
 */
const FIXTURE = /-fixture\.ts$/;

/** Re-exports of ANOTHER package's value — a package's own subpath is not a second package. */
export function packageReexports(file: {
  readonly at: string;
  readonly text: string;
}): readonly Reexport[] {
  if (FIXTURE.test(file.at)) return [];
  const own = packageOfPath(file.at);
  return reexportsIn(file.text, isPackageValue).filter((hit) => entryFor(hit.from)?.pkg !== own);
}

/** Every pin key a file's re-exports carry, pinned or not — what a stale row is measured against. */
export const packageReexportKeys = (file: {
  readonly at: string;
  readonly text: string;
}): string[] => packageReexports(file).map((hit) => reexportKey(file.at, hit.from, hit.name));

const violation = (
  file: { readonly at: string; readonly text: string },
  hit: Reexport,
): Finding => {
  const home = homeOf(hit.from, hit.name);
  const whole = hit.name === '*';
  const value = whole ? `${hit.from} namespace` : hit.name;
  const use = whole
    ? `import * as ns from '${hit.from}'`
    : `import { ${home.name} } from '${home.specifier}'`;
  const renamed = hit.alias === hit.name ? '' : ` as \`${hit.alias}\``;
  const owner = whole ? hit.from : home.specifier;
  return {
    code: 'X_HELPER_COPY',
    cause: `${file.at}:${lineOf(file.text, hit.index)} is a second ${value} — a re-export of ${owner}'s${renamed}, so one value has two import paths; ${owner} is its one home`,
    fix: `${use} at every caller and delete the re-export in ${file.at}`,
    at: file.at,
  };
};

/** One finding per re-exported value, at its line; exempt rows are not. */
export const packageReexportViolations = (file: {
  readonly at: string;
  readonly text: string;
}): readonly Finding[] =>
  packageReexports(file)
    .filter((hit) => !EXEMPT.has(reexportKey(file.at, hit.from, hit.name)))
    .map((hit) => violation(file, hit));
