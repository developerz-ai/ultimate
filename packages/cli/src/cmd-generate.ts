// `x g <primitive> <name>` — scaffolding with tests that pass on the first run. A generator that
// emits a TODO has moved the work, not done it; every file this writes typechecks, and every
// primitive arrives with the test that pins its distant invariants (policy, idempotency, budget).

// `resolve`/`sep` and not `join`: only resolving the assembled path can prove it stayed inside the
// app root, and `node:path` is the only API that resolves one. `node:fs` for the exists check.
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { appManifest, writeAppManifest } from './app-manifest';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import {
  CliNotImplementedError,
  GenerateJsonInvalidError,
  ScaffoldPathEscapeError,
} from './errors';
// Re-exported below: `GENERATORS` and `Generator` are imported from this module by the tests, the
// scaffold fixture and `src/index.ts`, and moving where they are declared must not move where they
// are read from.
import type { Generator } from './generate-kinds';
import {
  assertSurfaceSupported,
  GENERATORS,
  readKind,
  readName,
  readSurface,
} from './generate-kinds';
import { mergeJsonDeep } from './json-merge';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { flagBool, flagList, flagString } from './parse';
import type { GeneratedFile, Surface } from './templates';
import {
  actionFiles,
  adminPageFiles,
  backfillFiles,
  CATALOG_ROOT,
  entityFiles,
  guardFiles,
  i18nIndex,
  islandFiles,
  jobFiles,
  kebab,
  policyFiles,
  queryFiles,
  resolveLocales,
  resourceFiles,
  routeFiles,
  taskFiles,
} from './templates';

export type { Generator } from './generate-kinds';
export { GENERATORS } from './generate-kinds';

export interface GenerateOptions {
  readonly kind: Generator;
  readonly name: string;
  readonly feature?: string;
  readonly surface?: Surface;
  readonly live?: boolean;
  /** `resource` only: also emit the per-entity admin override. */
  readonly admin?: boolean;
  /** Every locale a generated i18n catalog entry ships for. Defaults to `['en']`. */
  readonly locales?: readonly string[];
  /**
   * `island` and `admin:page`: the directory the generated files land in. Named rather than
   * derived, because neither destination is derivable — `X_ISLAND_INVALID`'s cause already holds
   * the path a page's `src` resolved to, and an app's admin is wherever its `defineAdmin` is.
   */
  readonly at?: string;
  /** `admin:page` only: the permission the page's own work needs, on top of `admin:read`. */
  readonly permission?: string;
}

const DEFAULT_SURFACE_DIR: Record<Surface, string> = {
  site: 'apps/web/site',
  app: 'apps/web/app',
};

/** `undefined` when `text` does not parse as a JSON object — the one shape every catalog, whether
 * generated or hand-edited on disk, must hold. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** Deterministic catalog bytes: sorted keys, 2-space indent, trailing newline — a diff shows only
 * the keys a run actually changed, never a reordering. */
function prettyJson(value: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Two generators can legitimately produce the same shared file. A plain file (errors.ts) keeps
 * first-write-wins; a `merge: 'json'` catalog instead merges every contributor's keys into one
 * file — `resourceFiles` and `routeFiles` both target the same locale's catalog, and a plain
 * overwrite would drop whichever generator ran first. Later entries fill keys the earlier one
 * lacks; the first occurrence wins a clash, the same rule `writeFiles` applies against the copy
 * already on disk. Exported so `x new` (`cmd-new.ts`) and the scaffold fixture resolve a shared
 * catalog the identical way — one merge rule, not three hand-copied ones.
 *
 * A `merge: 'json'` file's `contents` are the generator's own output, not user data — one that
 * fails to parse as a JSON object is a bug in the template that produced it, so it throws here
 * rather than being silently treated as `{}` and merged into (or written as) a catalog with
 * attribution to nobody. `writeFiles`/`mergeJsonFile` never see a malformed *generated* payload in
 * practice: every production caller (`generate()` below, `cmd-new.ts`'s `planNewApp()`, the
 * scaffold fixture) runs its file list through this function first.
 */
export function dedupe(files: readonly GeneratedFile[]): readonly GeneratedFile[] {
  const seen = new Map<string, GeneratedFile>();
  for (const file of files) {
    if (file.merge === 'json' && parseJsonObject(file.contents) === undefined) {
      throw new GenerateJsonInvalidError({ path: file.path });
    }
    const prior = seen.get(file.path);
    if (prior === undefined) {
      seen.set(file.path, file);
    } else if (prior.merge === 'json' && file.merge === 'json') {
      // Both sides already proved parseable above — the fallback only guards a future change to
      // that invariant, it never fires today. Deep: two generators contributing to one nested
      // catalog share top-level keys (`app`, `admin`), and a shallow spread drops one of them.
      const later = parseJsonObject(file.contents) ?? {};
      const earlier = parseJsonObject(prior.contents) ?? {};
      const { merged } = mergeJsonDeep(earlier, later);
      seen.set(file.path, { ...prior, contents: prettyJson(merged) });
    }
    // else: not mergeable — first write wins, exactly as it always has.
  }
  return [...seen.values()];
}

/**
 * Pure: returns the files a generator would write. `x g` writes them, the generator test asserts
 * on them, and nothing has to run a filesystem to review what a generator produces.
 */
export function generate(options: GenerateOptions): readonly GeneratedFile[] {
  const surface: Surface = options.surface ?? 'app';
  assertSurfaceSupported(options.kind, surface, options.name);
  const surfaceDir = DEFAULT_SURFACE_DIR[surface];
  const feature = options.feature ?? options.name;
  const target = { surfaceDir, feature };
  switch (options.kind) {
    case 'resource':
      return dedupe(
        resourceFiles(options.name, {
          ...target,
          admin: options.admin === true,
          ...(options.locales === undefined ? {} : { locales: options.locales }),
        }),
      );
    case 'action':
      return dedupe(actionFiles(options.name, target));
    case 'mutator':
      return dedupe(actionFiles(options.name, { ...target, mutator: true }));
    case 'backfill':
      return dedupe(backfillFiles(options.name, target));
    case 'entity':
      return dedupe(entityFiles(options.name, target));
    case 'policy':
      return dedupe(policyFiles(options.name, target));
    case 'query':
      return dedupe(queryFiles(options.name, { ...target, live: options.live === true }));
    case 'job':
      return dedupe(jobFiles(options.name, target));
    case 'task':
      return dedupe(taskFiles(options.name, target));
    case 'island':
      return dedupe(islandFiles(options.name, { dir: options.at ?? `${surfaceDir}/${feature}` }));
    // No `--at`, no surface, no feature: `guards/` is the one directory the gate discovers, and a
    // guard that lived anywhere else would need an app-side registration to be found.
    case 'guard':
      return dedupe(guardFiles(options.name));
    case 'admin:page':
      // A default permission, never none: an empty list is `X_ADMIN_PAGE_UNGUARDED` on sight.
      return dedupe(
        adminPageFiles(options.name, {
          permission: options.permission ?? `${kebab(options.name)}:read`,
          // The same `--at` `island` takes: an app's admin is wherever its `defineAdmin` is.
          ...(options.at === undefined ? {} : { dir: options.at }),
          ...(options.locales === undefined ? {} : { locales: options.locales }),
        }),
      );
    case 'route':
      // `--locales` reaches the route generator too: its catalog entry is the route's title and
      // description, and a locale asked for on the command line is a locale that gets a file.
      return dedupe(
        routeFiles(options.name, {
          surface,
          ...(options.locales === undefined ? {} : { locales: options.locales }),
        }),
      );
    default:
      throw new CliNotImplementedError({
        feature: `generator "${String(options.kind)}"`,
        fix: `x g ${GENERATORS.join('|')}`,
      });
  }
}

export interface WriteReport {
  readonly written: readonly string[];
  readonly conflicts: readonly Finding[];
}

/**
 * `GeneratedFile.path` is documented as relative-POSIX, not enforced as it: `join` would happily
 * walk out of the app on a `..` segment or ignore the root entirely on an absolute path. Proven
 * before the write, once per file, because after the write there is nothing left to prove.
 */
export function containedPath(root: string, path: string): string {
  const base = resolve(root);
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(`${base}${sep}`))
    // The default `fix` names the scaffold gate's own test, which repairs nothing for someone
    // running `x g`: the fix here is the generate command, re-run as a dry run.
    throw new ScaffoldPathEscapeError({
      path,
      dir: base,
      // Command first, the caveat behind a `#`: the line runs verbatim and the shell drops the
      // rest. `x g <kind> <name>` pasted into bash is a redirect, not a command.
      fix: `x g resource posts --dry-run   # name every file relative to the app root, no ".." segment`,
    });
  return target;
}

/**
 * A `merge: 'json'` catalog is never a conflict on existence and never subject to `--force`: an
 * existing key on disk always wins, because it may hold a human translation, and only genuinely
 * new keys are added — so a second, third… generator run keeps growing the same file instead of
 * fighting over it. A file that exists but does not parse as a JSON object cannot be merged into
 * without risking silent data loss, so that alone is reported rather than clobbered or thrown past.
 *
 * Typed to the `merge: 'json'` variant alone, not the general `GeneratedFile` union: a
 * byte-carrying file has no `contents: string` to merge, and this is what stops one from ever
 * reaching `parseJsonObject` even if a future caller forgets the `file.merge === 'json'` guard
 * its one call site already applies.
 */
async function mergeJsonFile(
  file: Extract<GeneratedFile, { merge: 'json' }>,
  absolute: string,
): Promise<{ written: boolean; conflict?: Finding }> {
  const generated = parseJsonObject(file.contents) ?? {};
  if (!existsSync(absolute)) {
    await Bun.write(absolute, prettyJson(generated));
    return { written: true };
  }
  const existing = parseJsonObject(await Bun.file(absolute).text());
  if (existing === undefined) {
    return {
      written: false,
      conflict: {
        code: 'X_GENERATE_CONFLICT',
        cause: `${file.path} exists but is not a JSON object, so its keys cannot be merged`,
        fix: `edit ${file.path} by hand until it parses as a JSON object, or delete it and re-run x g`,
        docs: 'https://ultimate.dev/errors/X_GENERATE_CONFLICT',
        at: file.path,
      },
    };
  }
  // An existing key wins because it may hold a human translation; only the new keys are added.
  // Deep, so a nested catalog gains `site.blog.title` without losing the rest of `site`.
  const { merged, gained } = mergeJsonDeep(existing, generated);
  // Every key the generator wants is already there — leave the file untouched and unclaimed.
  if (!gained) return { written: false };
  await Bun.write(absolute, prettyJson(merged));
  return { written: true };
}

/** Never clobbers. A generator that overwrites is a generator nobody runs twice. */
export async function writeFiles(
  root: string,
  files: readonly GeneratedFile[],
  force: boolean,
): Promise<WriteReport> {
  const written: string[] = [];
  const conflicts: Finding[] = [];
  // Containment first, for every file: a run that stopped at the offender would already have put
  // the earlier files on disk, so the whole set is proven before any of it lands.
  const targets = files.map((file) => ({ file, absolute: containedPath(root, file.path) }));
  for (const { file, absolute } of targets) {
    if (file.merge === 'json') {
      const result = await mergeJsonFile(file, absolute);
      if (result.written) written.push(file.path);
      if (result.conflict !== undefined) conflicts.push(result.conflict);
      continue;
    }
    if (!force && existsSync(absolute)) {
      conflicts.push({
        code: 'X_GENERATE_CONFLICT',
        cause: `${file.path} already exists`,
        fix: `x g --force to overwrite, or pass a different name`,
        docs: 'https://ultimate.dev/errors/X_GENERATE_CONFLICT',
        at: file.path,
      });
      continue;
    }
    // Bun.write creates missing parent directories, so a generator never needs an mkdir step.
    await Bun.write(absolute, file.contents);
    written.push(file.path);
  }
  return { written, conflicts };
}

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
    const report = await writeFiles(root, files, flagBool(ctx.args, 'force'));
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
