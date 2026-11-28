// The rows ci.yml's `scaffold-smoke` runs, as the matrix `changes` hands it: every scaffold on a
// push, a dispatch or the nightly schedule, and on a pull request every scaffold only when the diff
// reaches the code that writes one — otherwise a sample of three. A doubt is every row.

import { NEW_SHAPES } from '../../../packages/cli/src/new-shapes';

export interface ScaffoldRow {
  readonly app: string;
  /** `x new` flags: empty, one flag, or a flag and its value — the job splits them on purpose. */
  readonly flags: string;
}

/**
 * The default, `--no-example`, one row per `x new --shape` (projected from `NEW_SHAPES`, so a new
 * shape has a runner the day it lands), and the monorepo the job grows with `x g app`/`x g package`.
 */
export const SCAFFOLD_ROWS: readonly ScaffoldRow[] = [
  { app: 'demoapp', flags: '' },
  { app: 'bareapp', flags: '--no-example' },
  ...NEW_SHAPES.map((shape) => ({ app: `${shape}app`, flags: `--shape ${shape}` })),
  { app: 'multiapp', flags: '' },
];

/**
 * What a pull request away from the scaffold code runs: the default (islands, the example slice),
 * the bare app (the one with nothing to read), and `saas` (a shape overlay: tenants, auth, billing).
 * A shape-only regression from elsewhere surfaces on the push to main or the nightly full matrix.
 */
export const SCAFFOLD_SAMPLE: readonly string[] = ['demoapp', 'bareapp', 'saasapp'];

/**
 * The code that writes or drives a scaffold: the CLI's templates, `x new` and `x g`, the shapes,
 * `create-ultimate`, the smoke's own scripts, this sampler, the workflow and its setup, and every
 * manifest or lockfile (a scaffold installs this repo's packages through `file:` overrides).
 */
const SCAFFOLD_CODE: readonly RegExp[] = [
  /^packages\/cli\/src\/templates\//,
  /^packages\/cli\/src\/(?:cmd-new|cmd-generate|generate|new-shapes|scaffold|write-generated)[^/]*$/,
  /^packages\/create-ultimate\//,
  /^scripts\/(?:scaffold|generator|template-codemods)[^/]*$/,
  /^scripts\/(?:ci-changes|lib\/ci\/scaffold-matrix)[^/]*$/,
  /^\.github\/(?:workflows\/ci\.yml|actions\/)/,
  /(?:^|\/)package\.json$/,
  /^bun\.lock$/,
];

export interface ScaffoldPlan {
  readonly full: boolean;
  readonly reason: string;
  /** `strategy.matrix` as `fromJSON` reads it. */
  readonly matrix: { readonly include: readonly ScaffoldRow[] };
}

/** A path git quoted, or one that climbs, is not a path anything here can rule out. */
const doubtful = (path: string): boolean => path.startsWith('"') || path.split('/').includes('..');

const reaches = (path: string): boolean =>
  doubtful(path) || SCAFFOLD_CODE.some((pattern) => pattern.test(path));

const every = (reason: string): ScaffoldPlan => ({
  full: true,
  reason,
  matrix: { include: SCAFFOLD_ROWS },
});

/** `event` is `github.event_name`; only `pull_request` may sample. */
export function scaffoldPlan(files: readonly string[], event: string): ScaffoldPlan {
  if (event !== 'pull_request') return every(`a ${event || 'run with no event'}: every scaffold`);
  if (files.length === 0) return every('no changed paths were read: every scaffold');
  const hit = files.find(reaches);
  if (hit !== undefined) return every(`${hit} reaches the scaffold code: every scaffold`);
  return {
    full: false,
    reason: `no changed path reaches the scaffold code: ${SCAFFOLD_SAMPLE.join(', ')}`,
    matrix: { include: SCAFFOLD_ROWS.filter((row) => SCAFFOLD_SAMPLE.includes(row.app)) },
  };
}
