// `x g invite`: the member invite's files written through the one writer (`writeFiles` — a second
// run conflicts and writes nothing), then the edits outside them: `member:invite` granted to
// `admin`, the three actions listed in the API index, and each one's exercise entry turned off
// with its reason, so the app's next `x verify` is green. No name and no flag: one invite per app.

import { indexBindingFindings } from './api-registration';
import { generateSpec } from './cmd-generate-spec';
import type { CommandContext } from './command';
import { invocationOf } from './command';
import { BadFlagError } from './errors';
import { localiseCatalogs, namedOrAppLocales } from './generate-catalog-locales';
import { appDisk, plannedDisk } from './generate-disk';
import { writtenExercises } from './generate-exercise';
import { generate } from './generate-files';
import { followUpEdits } from './generate-follow-ups';
import { formatWritten } from './generate-format-written';
import { appManifestIfAny, existingArtifacts } from './generate-sign-in-manifest';
import { planWrites, writeFiles } from './generate-write';
import { resolveDbModule } from './handle-registration';
import { resolveCatalogModule } from './i18n-audit';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagBool, flagList, type ParsedArgs } from './parse';
import { resolveLocales } from './templates';
import { withDependency } from './workspace-dep-edit';

const KIND = 'invite';

/** The `x g` flags this generator reads; any other one would change nothing, so is refused. */
const READS = new Set(['force', 'dry-run', 'locales', 'json']);

/** No `<name>` and no flag it ignores: a second spelling of one command is refused, not dropped. */
export function refuseInviteArgs(args: ParsedArgs): void {
  const named = args.positionals[1];
  if (named !== undefined) {
    throw new BadFlagError({
      flag: 'name',
      command: 'g invite',
      reason: `an app has one member invite, so "${named}" names nothing`,
      fix: 'x g invite',
    });
  }
  for (const flag of generateSpec.flags ?? []) {
    if (READS.has(flag.name)) continue;
    const value = args.flags.get(flag.name);
    if (value === undefined || value === flag.default) continue;
    throw new BadFlagError({
      flag: flag.name,
      command: 'g invite',
      reason: `the invite generator does not read --${flag.name}, so it would change nothing`,
      fix: 'x g invite',
    });
  }
}

const ROOT_MANIFEST = 'package.json';
const MAIL_PACKAGE = '@ultimat3/mail';

/**
 * The root manifest with `@ultimat3/mail` declared at the range the app already holds
 * `@ultimat3/auth` at — the invite mails. `x new` declares it from this release on; the edit is for an
 * app scaffolded before that. `undefined` when it is
 * declared already, or the manifest is not one this can read; `package-shape` then names the line.
 */
async function mailDependency(root: string): Promise<string | undefined> {
  const text = await appDisk(root).read(ROOT_MANIFEST);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const deps =
    typeof parsed === 'object' && parsed !== null && 'dependencies' in parsed
      ? (parsed as { readonly dependencies?: unknown }).dependencies
      : undefined;
  const range =
    typeof deps === 'object' && deps !== null
      ? (deps as Readonly<Record<string, unknown>>)['@ultimat3/auth']
      : undefined;
  return typeof range === 'string' ? withDependency(text, MAIL_PACKAGE, range) : undefined;
}

export async function runInvite(ctx: CommandContext, root: string): Promise<CommandResult> {
  refuseInviteArgs(ctx.args);
  const catalogModule = await resolveCatalogModule(root);
  const dbModule = await resolveDbModule(root);
  const locales = resolveLocales(await namedOrAppLocales(root, flagList(ctx.args, 'locales')));
  const files = await localiseCatalogs(
    root,
    generate({
      kind: KIND,
      name: KIND,
      locales,
      ...(catalogModule === undefined ? {} : { catalogModule }),
    }),
  );
  const invocation = [invocationOf(ctx, 'g'), KIND].join(' ');
  const force = flagBool(ctx.args, 'force');
  // An app already binding `inviteMember` in its API index is refused before anything lands.
  const bindings = await indexBindingFindings(
    root,
    files.map((file) => file.path),
    `${invocation}   # after renaming what apps/web/api/index.ts already binds under that name`,
  );

  if (flagBool(ctx.args, 'dry-run')) {
    const plan = await planWrites(root, files, force, invocation, KIND);
    const planned = new Map(
      files.flatMap((file) =>
        plan.written.includes(file.path) && typeof file.contents === 'string'
          ? [[file.path, file.contents] as const]
          : [],
      ),
    );
    const refused = [...plan.conflicts, ...bindings];
    const follow =
      refused.length > 0
        ? { edited: [], findings: [] }
        : await followUpEdits(
            root,
            plan.written,
            dbModule,
            plannedDisk(root, planned),
            writtenExercises(files, plan.written),
          );
    const manifest = refused.length > 0 ? undefined : await mailDependency(root);
    const touched =
      refused.length > 0
        ? []
        : [
            ...new Set([
              ...plan.written,
              ...follow.edited,
              ...(manifest === undefined ? [] : [ROOT_MANIFEST]),
            ]),
          ];
    const findings = [...refused, ...follow.findings];
    return {
      ok: findings.length === 0,
      command: 'g',
      summary: msg('cli.generate.planned', { count: touched.length, kind: KIND, name: KIND }),
      data: {
        files: touched,
        ...(touched.length === 0 ? {} : { refreshes: [...(await existingArtifacts(root))] }),
        dryRun: true,
      },
      lines: touched.map((path) => msg('cli.file.added', { path })),
      findings,
    };
  }

  const report =
    bindings.length > 0
      ? { written: [], conflicts: bindings }
      : await writeFiles(root, files, force, invocation, KIND);
  if (report.conflicts.length > 0) {
    return {
      ok: false,
      command: 'g',
      summary: msg('cli.generate.wrote', { count: 0, kind: KIND, name: KIND }),
      data: { files: [] },
      findings: report.conflicts,
    };
  }
  const manifest = await mailDependency(root);
  if (manifest !== undefined) await appDisk(root).write(ROOT_MANIFEST, manifest);
  const follow = await followUpEdits(
    root,
    report.written,
    dbModule,
    appDisk(root),
    writtenExercises(files, report.written),
  );
  await formatWritten(root, report.written, ctx.runner);
  const refreshed = await appManifestIfAny(root);
  const written = [
    ...new Set([
      ...report.written,
      ...(manifest === undefined ? [] : [ROOT_MANIFEST]),
      ...follow.edited,
      ...refreshed.written,
    ]),
  ];
  const findings = [...follow.findings, ...refreshed.findings];
  return {
    ok: findings.length === 0,
    command: 'g',
    summary: msg('cli.generate.wrote', { count: written.length, kind: KIND, name: KIND }),
    data: { files: written },
    lines: written.map((path) => msg('cli.file.added', { path })),
    findings,
  };
}
