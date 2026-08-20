// `x g <primitive> <name>` — scaffolding with tests that pass on the first run. A generator that
// emits a TODO has moved the work, not done it; every file this writes typechecks, and every
// primitive arrives with the test that pins its distant invariants (policy, idempotency, budget).

import { existsSync } from 'node:fs';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { appManifest, writeAppManifest } from './app-manifest';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { generate } from './generate-files';
import { GENERATORS, readKind, readName, readSurface } from './generate-kinds';
import { containedPath, writeFiles } from './generate-write';
import { resolveCatalogModule } from './i18n-audit';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { flagBool, flagList, flagString } from './parse';
import { CATALOG_ROOT, i18nIndex, resolveLocales } from './templates';

// One import path for the generator, unchanged by the split: `index.ts`, `x new` and the scaffold
// fixture reach the kinds, the pure file list and the writer through this module, and a second path
// to any of them would be the ambiguity axiom 1 forbids.
export type { GenerateOptions } from './generate-files';
export { generate } from './generate-files';
export type { Generator } from './generate-kinds';
export { GENERATORS } from './generate-kinds';
export type { WriteReport } from './generate-write';
export { dedupe, writeFiles } from './generate-write';

const I18N_INDEX_PATH = 'packages/i18n/src/index.ts';

/**
 * `packages/i18n/src/index.ts` is the one module the app imports catalogs through, and it is
 * written once, at `x new` time, importing whichever locales existed then. A later `x g
 * ... --locales=es` lands `packages/i18n/catalogs/es.json` on disk, but nothing would otherwise
 * teach the index about it — the catalog file would exist with real keys in it and the app could
 * still never select that locale. Every run that wrote at least one file re-derives the FULL
 * locale set from `packages/i18n/catalogs/` — not just the locales this invocation asked for —
 * and rewrites the index to match. Bypasses `writeFiles` on purpose: this file is a projection of
 * the catalog directory, never app-authored content a conflict check should protect. An app with
 * no i18n package (deleted, or never scaffolded) is left alone.
 */
async function syncI18nIndex(root: string): Promise<void> {
  const indexAbsolute = containedPath(root, I18N_INDEX_PATH);
  if (!existsSync(indexAbsolute)) return;
  const catalogDir = containedPath(root, CATALOG_ROOT);
  const locales: string[] = [];
  if (existsSync(catalogDir)) {
    for await (const entry of new Bun.Glob('*.json').scan({ cwd: catalogDir, absolute: false })) {
      locales.push(entry.replace(/\.json$/, ''));
    }
  }
  await Bun.write(indexAbsolute, i18nIndex(locales));
}

export const generateCommand: CliCommand = {
  spec: {
    name: 'g',
    aliases: ['generate'],
    summary: 'scaffold a primitive with its passing test',
    // Projected from `GENERATORS`, never restated: the literal that used to live here had already
    // drifted — it omitted `backfill` — and a usage line that can disagree with the list it
    // describes is exactly the second source of truth axiom 2 forbids.
    usage: `x g ${GENERATORS.join('|')} <name> [--feature f]`,
    // Declared from the SAME constant `readKind` validates against: without it `fix-command.ts`
    // has no set to judge the word after `x g`, and two shipped `@ultimat3/admin` fix lines said
    // `x g migration` — a generator that has never existed — straight through the `errors` gate.
    positionalChoices: GENERATORS,
    requiresApp: true,
    flags: [
      { name: 'feature', type: 'string', summary: 'feature slice to write into' },
      { name: 'surface', type: 'string', summary: 'site | app', default: 'app' },
      { name: 'live', type: 'boolean', summary: 'subscribable query' },
      { name: 'admin', type: 'boolean', summary: 'resource: also emit the admin override' },
      { name: 'locales', type: 'string', summary: 'comma-separated locales, default en' },
      { name: 'at', type: 'string', summary: 'island, admin:page: directory to write into' },
      { name: 'permission', type: 'string', summary: 'admin:page: the permission it needs' },
      { name: 'force', type: 'boolean', summary: 'overwrite existing files' },
      { name: 'dry-run', type: 'boolean', summary: 'print the file list, write nothing' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('g', ctx.cwd).dir;
    const kind = readKind(ctx.args.positionals[0]);
    const name = readName(ctx.args.positionals[1], kind);
    const featureFlag = flagString(ctx.args, 'feature');
    // Both flags are resolved before a single file is planned: a bad surface or a locale that is
    // really a path fails here, with nothing written and nothing to undo.
    const surface = readSurface(flagString(ctx.args, 'surface'), kind, name);
    const locales = resolveLocales(flagList(ctx.args, 'locales'));
    const at = flagString(ctx.args, 'at');
    const permission = flagString(ctx.args, 'permission');
    // Read before a file is planned, like the flags above: which module a generated component
    // imports `useT()` from is a fact about THIS app, and `generate` is a pure function.
    const catalogModule = await resolveCatalogModule(root);
    const files = generate({
      kind,
      name,
      ...(featureFlag === undefined ? {} : { feature: featureFlag }),
      ...(at === undefined ? {} : { at }),
      ...(permission === undefined ? {} : { permission }),
      surface,
      live: flagBool(ctx.args, 'live'),
      admin: flagBool(ctx.args, 'admin'),
      locales,
      ...(catalogModule === undefined ? {} : { catalogModule }),
    });
    if (flagBool(ctx.args, 'dry-run')) {
      return {
        ok: true,
        command: 'g',
        summary: msg('cli.generate.planned', { count: files.length, kind, name }),
        data: { files: files.map((file) => file.path), dryRun: true },
        lines: files.map((file) => msg('cli.file.added', { path: file.path })),
      };
    }
    const report = await writeFiles(
      root,
      files,
      flagBool(ctx.args, 'force'),
      `x g ${kind} ${name}`,
    );
    // A locale's catalog existing on disk and the app being able to select it are two different
    // facts — see `syncI18nIndex`. Runs before the manifest load below so a route or resource
    // this same invocation just wrote never gets projected against a stale catalog registration.
    if (report.written.length > 0) await syncI18nIndex(root);
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
    if (report.written.length > 0 && existsSync(containedPath(root, MANIFEST_FILENAME))) {
      const { manifest, findings } = await appManifest(root);
      if (findings.length === 0) {
        await writeAppManifest(root, manifest);
        buildId = manifest.buildId;
      } else loadFailures.push(...findings);
    }
    const findings = [...report.conflicts, ...loadFailures];
    // One list behind all three renderings. The manifest was printed as a `+` line while the count
    // beside it came from `report.written` alone, so `x g island` said "wrote 2 file(s)" over three
    // lines — and `--json` carried the shorter list, which is the drift `--json` exists to prevent.
    const written = [...report.written, ...(buildId === undefined ? [] : [MANIFEST_FILENAME])];
    return {
      ok: findings.length === 0,
      command: 'g',
      summary: msg('cli.generate.wrote', { count: written.length, kind, name }),
      data: {
        files: written,
        ...(buildId === undefined ? {} : { manifest: { buildId } }),
      },
      lines: written.map((path) => msg('cli.file.added', { path })),
      findings,
    };
  },
};
