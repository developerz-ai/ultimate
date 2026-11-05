// `x g sign-in --password | --oidc <provider>`: the shape's files written through the one writer
// (`writeFiles` — a second run conflicts and writes nothing), then the edits outside them: the
// actions listed in the API index, `app.config.ts`'s `signInPath` and env keys, and — for OIDC —
// the authenticator swap that drops `x new`'s development viewer, only over `x new`'s own bytes.

import { ERROR_DOCS_URL, stringField } from '@ultimat3/core';
import { generateSpec } from './cmd-generate-spec';
import type { CommandContext } from './command';
import { invocationOf } from './command';
import { appDisk, plannedDisk } from './generate-disk';
import { generate } from './generate-files';
import { followUpEdits } from './generate-follow-ups';
import { formatWritten } from './generate-format-written';
import { APP_CONFIG, type SignInEnvKey, signInConfigEdit } from './generate-sign-in-config';
import { appManifestIfAny, existingArtifacts } from './generate-sign-in-manifest';
import { readSignInMode, type SignInMode, signInLabel } from './generate-sign-in-mode';
import { planWrites, writeFiles } from './generate-write';
import { resolveDbModule } from './handle-registration';
import { resolveCatalogModule } from './i18n-audit';
import { reproducedFlags } from './invocation-flags';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { flagBool } from './parse';
import { names } from './templates';
import { authFiles } from './templates/scaffold-auth';
import { DEV_ACTOR_FILES, signedInAuthenticatorFiles } from './templates/sign-in-authenticator';
import { oidcEnvPrefix } from './templates/sign-in-oidc';
import { SIGN_IN_PATH } from './templates/sign-in-shared';

/** The env keys an OIDC sign-in adds to `envSchema`; `SESSION_SECRET` and `APP_URL` exist already. */
export const oidcEnvKeys = (provider: string): readonly SignInEnvKey[] => {
  const prefix = oidcEnvPrefix(provider);
  return [
    { key: `${prefix}_ISSUER`, type: 'url', description: `The ${provider} OpenID Connect issuer.` },
    { key: `${prefix}_CLIENT_ID`, description: `The client id ${provider} issued this app.` },
    {
      key: `${prefix}_CLIENT_SECRET`,
      secret: true,
      description: `The client secret ${provider} issued this app.`,
    },
  ];
};

/** The app's slug, as `x new` named it: the root `package.json`'s `name`. */
async function appName(root: string): Promise<string | undefined> {
  const text = await appDisk(root).read('package.json');
  if (text === undefined) return undefined;
  return stringField(JSON.parse(text), 'name');
}

export interface AuthenticatorSwap {
  /** The files written over `x new`'s, and the ones deleted, when every one was still `x new`'s. */
  readonly replace: readonly { readonly path: string; readonly contents: string }[];
  readonly remove: readonly string[];
  readonly findings: readonly Finding[];
}

/** Whether `x new`'s authenticator and development viewer are on disk exactly as it wrote them. */
export async function planAuthenticatorSwap(root: string): Promise<AuthenticatorSwap> {
  const name = await appName(root);
  const scaffold = new Map(
    name === undefined ? [] : authFiles(names(name)).map((file) => [file.path, file.contents]),
  );
  const swapped = signedInAuthenticatorFiles();
  const paths = [...swapped.map((file) => file.path), ...DEV_ACTOR_FILES];
  const disk = appDisk(root);
  const edited: string[] = [];
  for (const path of paths) {
    const now = await disk.read(path);
    if (now !== undefined && now !== scaffold.get(path)) edited.push(path);
  }
  if (edited.length > 0) {
    return {
      replace: [],
      remove: [],
      findings: [
        {
          code: 'X_GENERATE_CONFLICT',
          cause: `${edited.join(', ')} ${edited.length === 1 ? 'is' : 'are'} no longer what x new wrote, so the development viewer was left in place rather than overwritten`,
          fix: 'rm apps/web/app/auth/dev-actor.ts apps/web/app/auth/dev-actor.test.ts   # then answer null in apps/web/app/auth/authenticator.ts where it called devAuthenticate(request)',
          docs: ERROR_DOCS_URL,
          at: edited[0] ?? '',
        },
      ],
    };
  }
  return {
    replace: swapped.map((file) => ({ path: file.path, contents: String(file.contents) })),
    remove: [...DEV_ACTOR_FILES],
    findings: [],
  };
}

export async function runSignIn(ctx: CommandContext, root: string): Promise<CommandResult> {
  const mode: SignInMode = readSignInMode(ctx.args);
  const label = signInLabel(mode);
  const catalogModule = await resolveCatalogModule(root);
  const dbModule = await resolveDbModule(root);
  const files = generate({
    kind: 'sign-in',
    name: label,
    signIn: mode,
    ...(catalogModule === undefined ? {} : { catalogModule }),
  });
  const flags = reproducedFlags(generateSpec, ctx.args);
  const invocation = [invocationOf(ctx, 'g'), 'sign-in', ...flags].join(' ');
  const force = flagBool(ctx.args, 'force');
  const swap =
    mode.kind === 'oidc'
      ? await planAuthenticatorSwap(root)
      : { replace: [], remove: [], findings: [] };
  const configSource = await appDisk(root).read(APP_CONFIG);
  const config = signInConfigEdit(
    configSource ?? '',
    SIGN_IN_PATH,
    mode.kind === 'oidc' ? oidcEnvKeys(mode.provider) : [],
  );
  // An app with no `app.config.ts` has no `signInPath` to declare: nothing to edit, nothing owed.
  const configFindings = configSource === undefined ? [] : config.findings;
  const configEdited = configSource !== undefined && config.contents !== configSource;

  if (flagBool(ctx.args, 'dry-run')) {
    const plan = await planWrites(root, files, force, invocation, label);
    const planned = new Map(
      files.flatMap((file) =>
        plan.written.includes(file.path) && typeof file.contents === 'string'
          ? [[file.path, file.contents] as const]
          : [],
      ),
    );
    const follow =
      plan.conflicts.length > 0
        ? { edited: [], findings: [] }
        : await followUpEdits(root, plan.written, dbModule, plannedDisk(root, planned));
    const findings = [...plan.conflicts, ...follow.findings, ...swap.findings, ...configFindings];
    const touched =
      plan.conflicts.length > 0
        ? []
        : [
            ...new Set([
              ...plan.written,
              ...follow.edited,
              ...swap.replace.map((file) => file.path),
              ...swap.remove,
              ...(configEdited ? [APP_CONFIG] : []),
            ]),
          ];
    return {
      ok: findings.length === 0,
      command: 'g',
      summary: msg('cli.generate.planned', { count: touched.length, kind: 'sign-in', name: label }),
      data: {
        files: touched,
        removes: [...swap.remove],
        // What a real run re-projects after it writes, named as `x g`'s other dry runs name them.
        ...(touched.length === 0 ? {} : { refreshes: [...(await existingArtifacts(root))] }),
        dryRun: true,
      },
      lines: touched.map((file) => msg('cli.file.added', { path: file })),
      findings,
    };
  }

  const report = await writeFiles(root, files, force, invocation, label);
  if (report.conflicts.length > 0) {
    return {
      ok: false,
      command: 'g',
      summary: msg('cli.generate.wrote', { count: 0, kind: 'sign-in', name: label }),
      data: { files: [] },
      findings: report.conflicts,
    };
  }
  const disk = appDisk(root);
  for (const file of swap.replace) await disk.write(file.path, file.contents);
  for (const path of swap.remove) await Bun.file(`${root}/${path}`).delete();
  if (configEdited) await disk.write(APP_CONFIG, config.contents);
  const follow = await followUpEdits(root, report.written, dbModule, disk);
  await formatWritten(root, report.written, ctx.runner);
  const refreshed = await appManifestIfAny(root);
  const written = [
    ...new Set([
      ...report.written,
      ...swap.replace.map((file) => file.path),
      ...(configEdited ? [APP_CONFIG] : []),
      ...follow.edited,
      ...refreshed.written,
    ]),
  ];
  const findings = [...follow.findings, ...swap.findings, ...configFindings, ...refreshed.findings];
  return {
    ok: findings.length === 0,
    command: 'g',
    summary: msg('cli.generate.wrote', { count: written.length, kind: 'sign-in', name: label }),
    data: { files: written, removed: [...swap.remove] },
    lines: written.map((path) => msg('cli.file.added', { path })),
    findings,
  };
}
