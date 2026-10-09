// `x g <primitive> <name>` — scaffolding with tests that pass on the first run. A generator that
// emits a TODO has moved the work, not done it; every file this writes typechecks, and every
// primitive arrives with the test that pins its distant invariants (policy, idempotency, budget).

import { existsSync } from 'node:fs';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { registerAdminResources } from './admin-registration';
import { indexBindingFindings, registerGeneratedPrimitives } from './api-registration';
import { writeAppArtifacts } from './app-artifacts';
import { appManifest } from './app-manifest';
import { requireAppRoot } from './app-root';
import { generateSpec } from './cmd-generate-spec';
import type { CliCommand, CommandContext } from './command';
import { invocationOf } from './command';
import { localiseCatalogs } from './generate-catalog-locales';
import { assertFeatureExists } from './generate-feature';
import { generate, sliceDir } from './generate-files';
import { ungrantedByGenerator } from './generate-grant-findings';
import { grantGeneratedPermissions } from './generate-grants';
import type { Generator } from './generate-kinds';
import { readFeature, readKind, readName, readPermission, readSurface } from './generate-kinds';
import { refusePluralTable } from './generate-plural';
import { refuseShadowedTypes, refuseShadowedValues } from './generate-shadow';
import { containedPath, planWrites, writeFiles } from './generate-write';
import { declareGeneratedImports } from './generated-imports';
import { registerGeneratedEntities, resolveDbModule } from './handle-registration';
import { resolveCatalogModule } from './i18n-audit';
import { catalogLocales, syncI18nIndex } from './i18n-index';
import { reproducedFlags } from './invocation-flags';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { flagBool, flagList, flagString } from './parse';
import { quoteArg } from './shell-quote';
import type { GeneratedFile } from './templates';
import { kebab, names, resolveLocales } from './templates';

// One import path for the generator, unchanged by the split: `index.ts`, `x new` and the scaffold
// fixture reach the kinds, the pure file list and the writer through this module, and a second path
// to any of them would be the ambiguity axiom 1 forbids.
export type { GenerateOptions } from './generate-files';
export { generate } from './generate-files';
export type { Generator } from './generate-kinds';
export { GENERATORS } from './generate-kinds';
export type { WriteReport } from './generate-write';
export { dedupe, writeFiles } from './generate-write';

/**
 * Names to suggest when the API index already holds the requested one, in order: the feature's
 * prefix, the kind's suffix, then that suffix numbered — kebab output, so each pastes into a shell
 * as one argument. The caller re-plans each and offers the first the index does not hold either.
 */
const freeNames = (
  kind: Generator,
  name: string,
  feature: string | undefined,
): readonly string[] => {
  const suffixed = `${kebab(name)}-${kind.split(':').at(-1) ?? kind}`;
  return [
    ...(feature === undefined ? [] : [`${kebab(feature)}-${kebab(name)}`]),
    suffixed,
    ...Array.from({ length: 8 }, (_unused, index) => `${suffixed}-${index + 2}`),
  ];
};

export const generateCommand: CliCommand = {
  spec: generateSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('g', ctx.cwd).dir;
    const kind = readKind(ctx.args.positionals[0]);
    const name = readName(ctx.args.positionals[1], kind);
    const featureFlag = readFeature(flagString(ctx.args, 'feature'), kind);
    // Both flags are resolved before a single file is planned: a bad surface or a locale that is
    // really a path fails here, with nothing written and nothing to undo.
    const surface = readSurface(flagString(ctx.args, 'surface'), kind, name);
    const locales = resolveLocales(await namedOrAppLocales(root, flagList(ctx.args, 'locales')));
    const at = flagString(ctx.args, 'at');
    // Read with the two above, and refused here for their reason: the value is spliced into the
    // emitted source three times, and a value that is not a `<resource>:<verb>` is a page the app
    // cannot compile — found after the files are on disk, which is the worst place to find it.
    const permission = readPermission(flagString(ctx.args, 'permission'), kind);
    // Read before a file is planned, like the flags above: which module a generated component
    // imports `useT()` from is a fact about THIS app, and `generate` is a pure function.
    const catalogModule = await resolveCatalogModule(root);
    // And for the same reason: which package a generated `repo.ts` imports the typed handle from.
    const dbModule = await resolveDbModule(root);
    // And whether the app has the frame a resource's page sits in.
    const shell = existsSync(containedPath(root, SHELL_MODULE));
    // Read for the same reason: which errors the slice declares is written on THIS app's disk.
    const slice = sliceDir(surface, kebab(featureFlag ?? name));
    // A named slice that is not there is refused, never invented (X_FEATURE_UNKNOWN).
    assertFeatureExists(root, kind, featureFlag, slice);
    const sliceErrors = await readSliceErrors(root, kind, slice);
    // Same reason again: whether `job`/`task` may assume the tenant-scoped shape is a fact about
    // THIS feature's own `entity.ts`/`repo.ts`, not a default the template gets to assume.
    const sliceEntity = await readSliceFile(root, kind, slice, 'entity.ts');
    const sliceRepo = await readSliceFile(root, kind, slice, 'repo.ts');
    const planFor = (planned: string) =>
      generate({
        kind,
        name: planned,
        ...(featureFlag === undefined ? {} : { feature: featureFlag }),
        ...(sliceErrors === undefined ? {} : { sliceErrors }),
        ...(sliceEntity === undefined ? {} : { sliceEntity }),
        ...(sliceRepo === undefined ? {} : { sliceRepo }),
        ...(at === undefined ? {} : { at }),
        ...(permission === undefined ? {} : { permission }),
        surface,
        live: flagBool(ctx.args, 'live'),
        admin: flagBool(ctx.args, 'admin'),
        locales,
        ...(catalogModule === undefined ? {} : { catalogModule }),
        ...(dbModule === undefined ? {} : { dbModule }),
        shell,
      });
    // A non-default locale's strings arrive marked, and a locale with no catalog yet is refused
    // with `x i18n add <locale>` — before a dry run answers, so it answers the same files.
    const files = await localiseCatalogs(root, planFor(name));
    // On the planned files, before a dry run answers or anything lands: a name whose type spelling
    // the emitted code also uses as a global is a slice that does not compile.
    refuseShadowedTypes(files, kind, name);
    // And one whose binding a planned file both imports and declares (`x g job job`).
    refuseShadowedValues(files, kind, name);
    // And a plural slice name that an `entity.ts` this run writes would pluralise again.
    refusePluralTable(files, kind, name, featureFlag, (path) =>
      existsSync(containedPath(root, path)),
    );
    // The caller's own invocation, EVERY flag it set included: without `--feature` the fix wrote
    // a second slice beside the one that conflicted.
    const flags = reproducedFlags(generateCommand.spec, ctx.args);
    const invocation = [invocationOf(ctx, 'g'), kind, quoteArg(name), ...flags].join(' ');
    // A module the API index would list under a name it already holds: refused before anything is
    // written, with the same run under a name that is free — re-planned and re-checked, so the
    // suggestion is never itself a conflict.
    const pathsOf = (planned: readonly GeneratedFile[]) => planned.map((file) => file.path);
    const held = await indexBindingFindings(root, pathsOf(files), '');
    let bindings: readonly Finding[] = [];
    if (held.length > 0) {
      let free = freeNames(kind, name, featureFlag).at(-1) ?? name;
      for (const candidate of freeNames(kind, name, featureFlag)) {
        if ((await indexBindingFindings(root, pathsOf(planFor(candidate)), '')).length > 0)
          continue;
        free = candidate;
        break;
      }
      const renamed = [invocationOf(ctx, 'g'), kind, quoteArg(free), ...flags].join(' ');
      bindings = held.map((finding) => ({ ...finding, fix: renamed }));
    }
    const force = flagBool(ctx.args, 'force');
    if (flagBool(ctx.args, 'dry-run')) {
      // The write plan, never the bare file list: what the real run would write, skip and refuse.
      const plan = await planWrites(root, files, force, invocation);
      const findings = [...plan.conflicts, ...bindings];
      const planned = findings.length === 0 ? plan.written : [];
      return {
        ok: findings.length === 0,
        command: 'g',
        summary: msg('cli.generate.planned', { count: planned.length, kind, name }),
        data: { files: planned, dryRun: true },
        lines: planned.map((file) => msg('cli.file.added', { path: file })),
        findings,
      };
    }
    const report =
      bindings.length > 0
        ? { written: [], conflicts: bindings }
        : await writeFiles(root, files, force, invocation);
    // The three edits a generated primitive needs outside its own slice, performed rather than
    // left as findings: a declared permission granted to a role, a job listed in `defineApi`, and
    // an entity added to the typed handle its `repo.ts` reads through. Before the manifest load
    // below, so the projection sees all three — a repo reading a table the handle lacks would not
    // load at all.
    const handle = await registerGeneratedEntities(root, report.written, dbModule);
    // And a fourth, for `--admin`: the override it wrote, listed where `defineAdmin()` reads it.
    const adminWiring = await registerAdminResources(root, report.written);
    // And a fifth, last because the others add imports too: every sibling workspace a written file
    // imports, declared in the manifest it landed under — or `package-shape` refuses the output.
    const edited = [
      ...new Set([
        ...(await grantGeneratedPermissions(root, report.written)),
        ...(await registerGeneratedPrimitives(root, report.written)),
        ...handle.edited,
        ...adminWiring.edited,
        ...(await declareGeneratedImports(root, report.written)),
      ]),
    ];
    // A grant that edit could not place is said so, with the role each permission belongs to: an
    // app whose role map is not the scaffold's got no grant and no word, and a 403 on every
    // endpoint the run had just written.
    const ungranted = await ungrantedByGenerator(root, report.written);
    // A locale's catalog existing on disk and the app being able to select it are two different
    // facts — see `syncI18nIndex`. Runs before the manifest load below so a route or resource
    // this same invocation just wrote never gets projected against a stale catalog registration.
    const indexSync =
      report.written.length > 0 ? await syncI18nIndex(root) : { registered: true, findings: [] };
    // Facts, not prose: every `x g` run leaves the route/action/entity/job/policy table current,
    // the same guarantee `x manifest` makes on its own — an agent reading it after `x g` never
    // sees a resource that exists on disk but not in the manifest.
    //
    // REFRESHED, never introduced. An app that has not run `x manifest` has no committed contract
    // to keep current, and writing one here hands the repo a generated file it never asked to
    // maintain — `x g island` in such an app created `x.manifest.json` out of nothing.
    let buildId: string | undefined;
    // A module that would not load is omitted from the registries, so a manifest written over a
    // partial load would replace the compatibility contract with a subset of the app. The scaffold
    // stays on disk — only the projection is withheld, and the load failures travel as findings.
    const loadFailures: Finding[] = [];
    // `openapi.json` rides with it (`writeAppArtifacts`): refreshing one contract and not the other
    // made this command's own output fail the `contract-diff` step.
    const artifacts: string[] = [];
    if (report.written.length > 0 && existsSync(containedPath(root, MANIFEST_FILENAME))) {
      const { manifest, findings } = await appManifest(root);
      if (findings.length === 0) {
        artifacts.push(
          ...(await writeAppArtifacts(root, manifest, { openapi: true, onlyExisting: true })),
        );
        buildId = manifest.buildId;
      } else loadFailures.push(...findings);
    }
    const findings = [
      ...report.conflicts,
      ...handle.findings,
      ...ungranted,
      ...adminWiring.findings,
      ...indexSync.findings,
      ...loadFailures,
    ];
    // One list behind all three renderings. The manifest was printed as a `+` line while the count
    // beside it came from `report.written` alone, so `x g island` said "wrote 2 file(s)" over three
    // lines — and `--json` carried the shorter list, which is the drift `--json` exists to prevent.
    const written = [...report.written, ...edited, ...artifacts];
    // Named only over a clean run: with a finding, the finding's own `fix:` is the next command.
    const table = names(isEntityKind(kind) ? name : (featureFlag ?? name)).table;
    const next = findings.length === 0 ? nextSteps(report.written, edited, table) : [];
    return {
      ok: findings.length === 0,
      command: 'g',
      summary:
        next.length === 0
          ? msg('cli.generate.wrote', { count: written.length, kind, name })
          : msg('cli.generate.wroteNext', {
              count: written.length,
              kind,
              name,
              next: next.join(' && '),
            }),
      data: {
        files: written,
        ...(next.length === 0 ? {} : { next }),
        ...(buildId === undefined ? {} : { manifest: { buildId } }),
      },
      lines: written.map((path) => msg('cli.file.added', { path })),
      findings,
    };
  },
};

/**
 * `--locales` when the caller named any, and otherwise every locale the app already has a catalog
 * for: a key written to `en` alone in an app that also ships `es` renders ⟦key⟧ for every Spanish
 * reader. A stem that is not a locale tag is some other JSON file, and not a catalog to write to.
 */
async function namedOrAppLocales(
  root: string,
  named: readonly string[],
): Promise<readonly string[]> {
  if (named.length > 0) return named;
  return (await catalogLocales(root)).filter((stem) => {
    try {
      return Intl.getCanonicalLocales(stem).length === 1;
    } catch {
      return false;
    }
  });
}

const isEntityKind = (kind: Generator): boolean => kind === 'entity' || kind === 'resource';

/**
 * What a run that declared a table owes before the app can read it, in the order it has to
 * happen — each one a command that runs as printed. `bunx x`, never a bare `x`: `bun install`
 * links the binary into `./node_modules/.bin` and nowhere on PATH.
 *
 * `bun install` leads when a manifest gained a workspace edge: the handle imports the entity from
 * the web workspace, and an edge only a manifest declares is not linked until the install runs.
 * `x db gen` then writes the migration AND `packages/db/schema/`, which the `drift` step holds.
 */
export function nextSteps(
  written: readonly string[],
  edited: readonly string[],
  table: string,
): readonly string[] {
  if (!written.some((path) => path.endsWith('/entity.ts'))) return [];
  return [
    ...(edited.some((path) => path.endsWith('package.json')) ? ['bun install'] : []),
    `bunx x db gen "create ${table}"`,
    'bunx x db migrate',
    // A page that mounts an island has a byte budget only a build can weigh — measured on `x new`'s
    // app (`RESOURCE_PAGE_BUDGET`), and an app that charges more per document is over it on this
    // run rather than on the next `bin/check`.
    ...(written.some((path) => path.endsWith('/page.tsx')) ? [MEASURE_PAGE] : []),
  ];
}

/** The two commands that weigh a page against its budget: the build writes the bytes it reads. */
export const MEASURE_PAGE = 'bunx x build --target static && bunx x verify --only budgets';

/** The frame `x new` writes: a resource's page renders inside it when the app has one. */
export const SHELL_MODULE = 'apps/web/shared/shell.tsx';

/**
 * The slice's `errors.ts`, for the two generators whose template throws from it. Only those two:
 * a route or an island names no slice, and the "feature" the fallback derives for them is a path
 * that exists nowhere — reading it would be answering a question nobody asked.
 */
async function readSliceErrors(
  root: string,
  kind: Generator,
  slice: string,
): Promise<string | undefined> {
  if (kind !== 'action' && kind !== 'mutator') return undefined;
  const file = containedPath(root, `${slice}/errors.ts`);
  return existsSync(file) ? await Bun.file(file).text() : undefined;
}

/** The generators whose output depends on what the slice's `entity.ts` / `repo.ts` declare. */
const READS_SLICE: ReadonlySet<Generator> = new Set([
  'job',
  'task',
  'action',
  'mutator',
  'query',
  'backfill',
]);

/**
 * The slice's `entity.ts`/`repo.ts` as they stand on disk, absent when the generator's kind reads
 * neither or the file does not exist yet. `readSliceErrors`'s reason — whichever generator reads
 * it decides on THIS app's disk, not on a default the template assumes. `query` reads them for its
 * test alone: whether it may store a row is a fact about the entity an author may have reshaped.
 * Exported so a test can ask which kinds read the disk without running a whole generation.
 */
export async function readSliceFile(
  root: string,
  kind: Generator,
  slice: string,
  name: 'entity.ts' | 'repo.ts',
): Promise<string | undefined> {
  if (!READS_SLICE.has(kind)) return undefined;
  const file = containedPath(root, `${slice}/${name}`);
  return existsSync(file) ? await Bun.file(file).text() : undefined;
}
