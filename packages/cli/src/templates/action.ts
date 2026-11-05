// `x g action` / `x g mutator` — a server-authoritative command, its policy, and the test that
// pins both. One declaration projects to an HTTP route, an OpenAPI operation, a typed client, a
// job handle, an MCP tool and these tests; the generator writes the declaration and the tests.

import { SlicePolicyIncompleteError } from '../generate-slice-policy';
import { actionContractTest, actionUnitTest } from './action-tests';
import type { FeatureTarget } from './entity';
import type { GeneratedFile, NameSet } from './naming';
import { names } from './naming';
import { PLACEHOLDER_DB_MODULE } from './scaffold-db-client';
import type { DeclaredEntity, SliceModule } from './slice-foundation';
import {
  exportsUnknown,
  foreignSliceEntity,
  grantOf,
  policyReadsOrg,
  sliceExports,
  sliceFoundation,
  sliceHasNoTenant,
  sliceTakesScaffoldRow,
} from './slice-foundation';
import { wrapImport } from './wrap';

/**
 * The handler's lookup-by-id, or the comment that says what a slice needs before it can have one.
 * `x g resource` writes a slice whose `errors.ts` declares `<Feature>NotFoundError`, and so does
 * the foundation this generator lays under an empty directory; a slice an author wrote by hand
 * (one adopter's `fleet`, with `HostNotFoundError` and `SessionNotFoundError`) declares the errors
 * it has and not this one. Importing it anyway is a file that fails at import.
 */
const missingLookup = (
  feature: NameSet,
  entity: boolean,
  foreign: DeclaredEntity | undefined,
): string =>
  foreign !== undefined
    ? `    // No lookup by id: ../entity declares ${foreign.binding} (${foreign.table}), not the
    // table this generator scaffolds, so it writes no repo around it. Read the row your own way here.`
    : entity
      ? `    // No lookup by id: ../errors declares no ${feature.pascal}NotFoundError, and a row that is not
    // there needs one to be thrown for it. Declare it there — the shape \`x g resource\` writes —
    // then read the row through ../repo and throw it when the read answers nothing.`
      : `    // No lookup by id: this feature has no entity, and a generator writing into a slice never
    // invents one. \`x g entity ${feature.kebab}\` declares the table; this body is yours until then.`;

/**
 * The refusals the handler may throw, closed from day one: a 4xx it throws outside the list is
 * `X_ERROR_UNDECLARED` in every test. The lookup's class answers its own code, so an
 * `errors.ts` the author wrote keeps whatever code it declares.
 */
const errorsLine = (feature: NameSet, lookup: boolean): string =>
  lookup
    ? `  // The refusals a caller may branch on: add each code the handler comes to throw.
  errors: [${feature.pascal}NotFoundError.code],`
    : `  // The refusals a caller may branch on: add each code the handler comes to throw.
  errors: [],`;

const actionSource = (
  name: NameSet,
  feature: NameSet,
  lookup: boolean,
  entity: boolean,
  org: boolean,
  foreign: DeclaredEntity | undefined,
): string => `// ${name.camel}: one mutation, server-authoritative. Input is validated before the handler runs
// and the policy is the same object the MCP tool and the HTTP route evaluate.
// \`t\` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.

import { action, t } from '@ultimat3/action';
// One directory up: actions live in \`actions/\`, the feature's errors, policy and repo are the
// slice's own files and are shared by every action in it.
${lookup ? `\nimport { ${feature.pascal}NotFoundError } from '../errors';\n` : ''}${wrapImport([`can${feature.pascal}Write`, `${feature.camel}Tag`], '../policy')}
${lookup ? "import * as repo from '../repo';\n" : ''}
export const ${name.camel} = action({
${
  org
    ? `  // orgId is part of the input because the policy decides on it — authz reads the declaration,
  // never the database.
  input: t.object({ id: t.uuid, orgId: t.uuid }),`
    : '  input: t.object({ id: t.uuid }),'
}
  output: t.object({ id: t.uuid${lookup ? ', title: t.string' : ''} }),
  policy: can${feature.pascal}Write,
  cache: { invalidates: [${feature.camel}Tag] },
${errorsLine(feature, lookup)}
  // No \`mcp\`: a tool's description is what an agent reads to decide to call it, and a placeholder
  // there is worse than no tool. Write one, then \`mcp: { expose: true, description: '…' }\`.
  async handle({ input }) {
${
  lookup
    ? `    const row = await repo.byId(input.id);
    if (row === undefined) throw new ${feature.pascal}NotFoundError({ id: input.id });
    return { id: row.id, title: row.title };`
    : `${missingLookup(feature, entity, foreign)}
    return { id: input.id };`
}
  },
});
`;

const mutatorSource = (
  name: NameSet,
  feature: NameSet,
  lookup: boolean,
  entity: boolean,
  org: boolean,
  foreign: DeclaredEntity | undefined,
): string => `// ${name.camel}: an action with an optimistic local twin. The local half runs against the client
// store immediately; the server half is authoritative and reconciles on conflict.

import { mutator, t } from '@ultimat3/action';
${lookup ? `import { ${feature.pascal}NotFoundError } from '../errors';\n` : ''}import { can${feature.pascal}Write } from '../policy';
${lookup ? "import * as repo from '../repo';\n" : ''}
interface Local${feature.pascal} {
  readonly id: string;
  readonly title: string;
  readonly pending: boolean;
}

export const ${name.camel} = mutator({
  input: t.object({ id: t.uuid,${org ? ' orgId: t.uuid,' : ''} title: t.string }),
  output: t.object({ id: t.uuid, title: t.string }),
  policy: can${feature.pascal}Write,
  // Required on a mutator (X_MUTATOR_NOT_IDEMPOTENT): the client replays this write under one
  // Idempotency-Key after a dropped response, and the replay answers the first result.
  idempotent: true,
${errorsLine(feature, lookup)}
  // No \`mcp\` until a real description is written: see \`x g action\`.
  // tx.table(name) rather than tx.${feature.plural}: the typed accessor exists only once the app
  // augments LocalTables, and generated code cannot assume that has happened yet. The name is the
  // entity's snake_case table, so the local twin and the server row live under one key.
  local(tx, input) {
    tx.table<Local${feature.pascal}>('${foreign?.table ?? feature.table}').update(input.id, {
      title: input.title,
      pending: true,
    });
  },
  async server(_ctx, input) {
${
  lookup
    ? `    const row = await repo.byId(input.id);
    if (row === undefined) throw new ${feature.pascal}NotFoundError({ id: input.id });
    return { id: row.id, title: input.title };`
    : `${missingLookup(feature, entity, foreign)}
    return { id: input.id, title: input.title };`
}
  },
  conflict: 'server-wins',
});
`;

export interface ActionOptions extends FeatureTarget {
  readonly mutator?: boolean;
  /**
   * The slice's `errors.ts` as it stands on disk, or absent when the slice has none yet. Absent,
   * the foundation writes one declaring `<Feature>NotFoundError` and the action may throw it;
   * present, the file is the author's and is never rewritten, so the action throws it only when
   * `sliceExports` finds it there.
   */
  readonly sliceErrors?: string;
  /**
   * The slice's `entity.ts`, or absent when the feature has none. Absent, the action reads no row
   * and the generator writes no entity — only `x g entity` and `x g resource` create a feature's
   * data. `x g resource` passes the entity it is writing in the same run.
   */
  readonly sliceEntity?: string;
  /** The slice's `repo.ts` as it stands on disk, or absent alongside `sliceEntity`. */
  readonly sliceRepo?: string;
  /**
   * The slice's `policy.ts` as it stands on disk, absent when the slice has none yet (and then the
   * scaffolded one is written). Read for `sliceErrors`'s reason: the generated file IMPORTS from
   * it, and what it exports is a fact about this app's disk.
   */
  readonly slicePolicy?: string;
}

export function actionFiles(rawName: string, target: ActionOptions): readonly GeneratedFile[] {
  const name = names(rawName);
  const feature = names(target.feature);
  const dir = `${target.surfaceDir}/${target.feature}/actions`;
  const isMutator = target.mutator === true;
  const entity = target.sliceEntity !== undefined;
  // Another table under this slice's name: nothing is planted around it, and no row is read.
  const foreign = foreignSliceEntity(target.feature, target.sliceEntity);
  // `job`'s reason: which shape fits is a fact about THIS slice's `entity.ts`, and the comment in
  // the one `x g entity` writes says deleting its tenant is a per-slice edit the generators read.
  // A policy still deciding on `input.orgId` keeps it in the input, because the action compiles
  // against the policy it imports and that file is its author's to change, never this generator's.
  const singleTenant = sliceHasNoTenant(target.sliceEntity);
  // The policy this run writes grants `<feature>:write`; a handwritten one, what it says.
  const grant =
    target.slicePolicy === undefined
      ? `${feature.kebab}:write`
      : grantOf(target.slicePolicy, `can${feature.pascal}Write`);
  const org =
    !singleTenant || (target.slicePolicy !== undefined && policyReadsOrg(target.slicePolicy));
  // Before a file is planned: a generated action that does not compile is refused, never written.
  assertPolicyExports(target, feature, isMutator);
  const lookup =
    entity &&
    foreign === undefined &&
    (target.sliceErrors === undefined ||
      sliceExports(target.sliceErrors, `${feature.pascal}NotFoundError`)) &&
    // The lookup calls `repo.byId`: a `repo.ts` an author wrote without one gets the neutral body.
    (target.sliceRepo === undefined || sliceExports(target.sliceRepo, 'byId'));
  // `../errors` only when the body throws from it: with no lookup it is a module nothing imports,
  // and an app's coverage floor counts it (`no unit test loads it`, a red first gate after this).
  const foundation: readonly SliceModule[] = [
    ...(entity && foreign === undefined ? (['entity'] as const) : []),
    'policy',
    ...(lookup ? (['errors'] as const) : []),
  ];
  return [
    // The three slice modules this action's source imports — `../errors`, `../policy`, `../repo`
    // (which comes with `../entity`, its row type). Composed rather than assumed: `x g action`
    // into a slice no `x g resource` had created emitted all three imports and wrote none of them.
    // With no entity, only the policy: a lookup-free body imports neither ../errors nor ../repo.
    // And ONLY those: an action is not a resource scaffold. A module already on disk is its
    // author's — it gets no test from here and no admin labels, both of which assert the shape
    // `x g resource` writes, not the one that is there (`withoutOwned`).
    ...withoutOwned(sliceFoundation(target, foundation, undefined, { singleTenant }), target),
    {
      path: `${dir}/${name.kebab}.ts`,
      contents: isMutator
        ? mutatorSource(name, feature, lookup, entity, org, foreign)
        : actionSource(name, feature, lookup, entity, org, foreign),
    },
    // TWO test files, because the gate types a test by its FILENAME and this declaration owes two
    // suites: the input parse is a `unit` assertion and the three projections are `contract` ones.
    // Emitted as one file, the contract half ran under `unit` and `x test contract` answered
    // X_TEST_NO_FILES; renaming that one file would have put the `unitTest` in the same bind.
    {
      path: `${dir}/${name.kebab}.test.ts`,
      contents: actionUnitTest(name, feature, {
        isMutator,
        lookup,
        storesRow: sliceTakesScaffoldRow(target, target.sliceEntity, target.sliceRepo),
        dbModule: target.dbModule ?? PLACEHOLDER_DB_MODULE,
        org,
        grant,
      }),
    },
    {
      path: `${dir}/${name.kebab}.contract.test.ts`,
      contents: actionContractTest(
        name,
        feature,
        isMutator,
        target.slicePolicy === undefined,
        target.slicePolicy === undefined && !singleTenant,
        // A hand-written policy's one literal grant: its exercise runs as an actor holding it.
        grant,
      ),
    },
  ];
}

/** The slice modules a run may find already written, and the files each would otherwise be handed. */
const OWNED = [
  ['sliceEntity', ['/entity.ts', '/entity.test.ts', '.json']],
  ['sliceRepo', ['/repo.ts', '/repo.test.ts']],
  ['slicePolicy', ['/policy.ts', '/policy.test.ts']],
] as const;

/**
 * The planted slice files, minus everything that belongs to a module ALREADY on disk. `if-absent`
 * protects a file; it does not know that `repo.test.ts` belongs to a `repo.ts` somebody wrote, so
 * a hand-written slice was handed three tests asserting the scaffold's shape and six admin labels
 * (the catalog `.json`) for an entity it had declared itself. A module this run does write keeps
 * every companion.
 */
function withoutOwned(
  files: readonly GeneratedFile[],
  target: ActionOptions,
): readonly GeneratedFile[] {
  const owned = OWNED.flatMap(([module, suffixes]) =>
    target[module] === undefined ? [] : suffixes,
  );
  return files.filter((file) => !owned.some((suffix) => file.path.endsWith(suffix)));
}

/**
 * Refuse a slice whose own `policy.ts` lacks what the generated file imports from it. An absent
 * `policy.ts` is not this case — the scaffolded one is written beside the action, with both names.
 *
 * Refused rather than adapted, unlike a missing `<Feature>NotFoundError`: there is no neutral
 * policy to fall back to. An inline `can('<feature>:write')` names a permission the slice's
 * `definePermissions()` never declared, which is a type error of its own.
 */
function assertPolicyExports(target: ActionOptions, feature: NameSet, isMutator: boolean): void {
  const source = target.slicePolicy;
  // A barrel re-exporting a module nobody could read: cannot tell, so never refused on a guess.
  if (source === undefined || exportsUnknown(source)) return;
  const needed = [`can${feature.pascal}Write`, ...(isMutator ? [] : [`${feature.camel}Tag`])];
  const missing = needed.filter((name) => !sliceExports(source, name));
  if (missing.length === 0) return;
  throw new SlicePolicyIncompleteError({
    policy: `${target.surfaceDir}/${target.feature}/policy.ts`,
    feature: target.feature,
    missing,
    kind: isMutator ? 'mutator' : 'action',
  });
}
