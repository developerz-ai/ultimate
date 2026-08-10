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
  BadFlagError,
  CliNotImplementedError,
  ScaffoldPathEscapeError,
  UnknownCommandError,
} from './errors';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { flagBool, flagList, flagString } from './parse';
import type { GeneratedFile, Surface } from './templates';
import {
  actionFiles,
  entityFiles,
  jobFiles,
  policyFiles,
  queryFiles,
  resolveLocales,
  resourceFiles,
  routeFiles,
  taskFiles,
} from './templates';

export const GENERATORS = [
  'resource',
  'action',
  'mutator',
  'job',
  'route',
  'policy',
  'entity',
  'query',
  'task',
] as const;

export type Generator = (typeof GENERATORS)[number];

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
 */
export function dedupe(files: readonly GeneratedFile[]): readonly GeneratedFile[] {
  const seen = new Map<string, GeneratedFile>();
  for (const file of files) {
    const prior = seen.get(file.path);
    if (prior === undefined) {
      seen.set(file.path, file);
    } else if (prior.merge === 'json' && file.merge === 'json') {
      const later = parseJsonObject(file.contents) ?? {};
      const earlier = parseJsonObject(prior.contents) ?? {};
      seen.set(file.path, { ...prior, contents: prettyJson({ ...later, ...earlier }) });
    }
    // else: not mergeable — first write wins, exactly as it always has.
  }
  return [...seen.values()];
}

/**
 * A resource slice is app-surface by construction: it ships a live query, a form with a signal,
 * two actions and a policy, and `site/` is the 0kb, never-hydrated surface that may not import
 * `app/`. The documented shape is the slice in `app/` plus a separate public route
 * (`docs/architecture/15-adding-a-feature.md`), so the flag is refused before anything is written
 * rather than emitting a slice that fails the app's own budget and boundary gates.
 */
function assertSurfaceSupported(kind: Generator, surface: Surface): void {
  if (kind !== 'resource' || surface !== 'site') return;
  throw new BadFlagError({
    flag: 'surface',
    command: 'g resource',
    reason: 'a resource slice is app-surface — site/ ships 0kb JS and may not import app/',
    fix: 'x g resource <name> && x g route <name> --surface site',
  });
}

/**
 * Pure: returns the files a generator would write. `x g` writes them, the generator test asserts
 * on them, and nothing has to run a filesystem to review what a generator produces.
 */
export function generate(options: GenerateOptions): readonly GeneratedFile[] {
  const surface: Surface = options.surface ?? 'app';
  assertSurfaceSupported(options.kind, surface);
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
      fix: `name the file relative to the app root with no ".." segment, then re-run: x g ${GENERATORS.join('|')} <name> --dry-run`,
    });
  return target;
}

/**
 * A `merge: 'json'` catalog is never a conflict on existence and never subject to `--force`: an
 * existing key on disk always wins, because it may hold a human translation, and only genuinely
 * new keys are added — so a second, third… generator run keeps growing the same file instead of
 * fighting over it. A file that exists but does not parse as a JSON object cannot be merged into
 * without risking silent data loss, so that alone is reported rather than clobbered or thrown past.
 */
async function mergeJsonFile(
  file: GeneratedFile,
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
  const gainedKeys = Object.keys(generated).some((key) => !(key in existing));
  // Every key the generator wants is already there — leave the file untouched and unclaimed.
  if (!gainedKeys) return { written: false };
  // An existing key wins because it may hold a human translation; only the new keys are added.
  await Bun.write(absolute, prettyJson({ ...generated, ...existing }));
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

function readKind(raw: string | undefined): Generator {
  const kinds: readonly string[] = GENERATORS;
  if (raw !== undefined && kinds.includes(raw)) return raw as Generator;
  throw new UnknownCommandError({
    path: `g ${raw ?? ''}`.trim(),
    known: GENERATORS,
    suggestion: 'g resource',
  });
}

/** Two surfaces, spelled exactly. A typo that fell through to `app` would scaffold the wrong one. */
function readSurface(raw: string | undefined, kind: Generator): Surface {
  if (raw === undefined || raw === 'app') return 'app';
  if (raw === 'site') return 'site';
  throw new BadFlagError({
    flag: 'surface',
    command: 'g',
    reason: `"${raw}" is not a surface (site, app)`,
    fix: `x g ${kind} <name> --surface app`,
  });
}

export const generateCommand: CliCommand = {
  spec: {
    name: 'g',
    aliases: ['generate'],
    summary: 'scaffold a primitive with its passing test',
    usage: 'x g resource|action|mutator|job|route|policy|entity|query|task <name> [--feature f]',
    requiresApp: true,
    flags: [
      { name: 'feature', type: 'string', summary: 'feature slice to write into' },
      { name: 'surface', type: 'string', summary: 'site | app', default: 'app' },
      { name: 'live', type: 'boolean', summary: 'subscribable query' },
      { name: 'admin', type: 'boolean', summary: 'resource: also emit the admin override' },
      { name: 'locales', type: 'string', summary: 'comma-separated locales, default en' },
      { name: 'force', type: 'boolean', summary: 'overwrite existing files' },
      { name: 'dry-run', type: 'boolean', summary: 'print the file list, write nothing' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('g', ctx.cwd).dir;
    const kind = readKind(ctx.args.positionals[0]);
    const name = ctx.args.positionals[1];
    if (name === undefined) {
      throw new UnknownCommandError({
        path: `g ${kind}`,
        known: GENERATORS,
        suggestion: `g ${kind} <name>`,
      });
    }
    const featureFlag = flagString(ctx.args, 'feature');
    // Both flags are resolved before a single file is planned: a bad surface or a locale that is
    // really a path fails here, with nothing written and nothing to undo.
    const surface = readSurface(flagString(ctx.args, 'surface'), kind);
    const locales = resolveLocales(flagList(ctx.args, 'locales'));
    const files = generate({
      kind,
      name,
      ...(featureFlag === undefined ? {} : { feature: featureFlag }),
      surface,
      live: flagBool(ctx.args, 'live'),
      admin: flagBool(ctx.args, 'admin'),
      locales,
    });
    if (flagBool(ctx.args, 'dry-run')) {
      return {
        ok: true,
        command: 'g',
        summary: msg('cli.generate.wrote', { count: files.length, kind, name }),
        data: { files: files.map((file) => file.path), dryRun: true },
        lines: files.map((file) => `  + ${file.path}`),
      };
    }
    const report = await writeFiles(root, files, flagBool(ctx.args, 'force'));
    // Facts, not prose: every `x g` run leaves the route/action/entity/job/policy table current,
    // the same guarantee `x manifest` makes on its own — an agent reading it after `x g` never
    // sees a resource that exists on disk but not in the manifest.
    let buildId: string | undefined;
    // A module that would not load is omitted from the registries, so a manifest written over a
    // partial load would replace the compatibility contract with a subset of the app. The scaffold
    // stays on disk — only the projection is withheld, and the load failures travel as findings.
    const loadFailures: Finding[] = [];
    if (report.written.length > 0) {
      const { manifest, findings } = await appManifest(root);
      if (findings.length === 0) {
        await writeAppManifest(root, manifest);
        buildId = manifest.buildId;
      } else loadFailures.push(...findings);
    }
    const findings = [...report.conflicts, ...loadFailures];
    return {
      ok: findings.length === 0,
      command: 'g',
      summary: msg('cli.generate.wrote', { count: report.written.length, kind, name }),
      data: {
        files: report.written,
        ...(buildId === undefined ? {} : { manifest: { buildId } }),
      },
      lines: [
        ...report.written.map((path) => `  + ${path}`),
        ...(buildId === undefined ? [] : [`  + ${MANIFEST_FILENAME}`]),
      ],
      findings,
    };
  },
};
