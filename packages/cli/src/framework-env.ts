// Single responsibility: the keys the FRAMEWORK refuses to boot without once deployed — the one
// list `.env.example`, `x env check` and `x doctor` all read. An app's `envSchema` names its own
// variables; these are the framework's, and a deploy contract that omits them crash-loops every
// role one key at a time (#679).

import type { EnvSchema } from '@ultimat3/core';
import {
  CURSOR_SECRET_FIX,
  CURSOR_SECRET_KEY,
  devSecretsRefused,
  ENV_EXAMPLE_PATH,
  ERROR_DOCS_URL,
  renderEnvExample,
  tryResolveEnvironment,
  usesDevCursorSecret,
} from '@ultimat3/core';
import { usesDevVapidKeys, VAPID_PRIVATE_KEY_ENV, VAPID_PUBLIC_KEY_ENV } from '@ultimat3/pwa';
import { STORAGE_SIGNING_SECRET_KEY, usesDevStorageSecret } from '@ultimat3/storage';
import type { Finding } from './output';
import { storageIsExternal } from './runtime-bindings';

type EnvTable = Readonly<Record<string, string | undefined>>;

/**
 * Does a process booting on `env` refuse the shipped development secrets? Core's
 * `devSecretsRefused` — the boot's own rule, which fails closed: a table naming no environment is
 * production. The ONE predicate `x env check` and `x doctor` gate on, so neither can call green an
 * environment the boot refuses. Throws `X_ENVIRONMENT_INVALID` on an unknown `ULTIMATE_ENV`.
 */
export const deployed = (env: EnvTable): boolean => devSecretsRefused({ env });

/**
 * Does `env` NAME a deployed environment — `ULTIMATE_ENV`, else `NODE_ENV`, resolving to
 * `staging` or `production`? `x doctor`'s gate, and deliberately not `deployed`: the two commands
 * answer different questions. `x env check` asks what a deployed boot does with a table, and the
 * boot fails closed, so an unnamed table is a deploy there. `x doctor` asks about THIS machine,
 * and a developer shell that names nothing is not a deploy — reporting the shipped keys there would
 * put two findings in front of every developer on day one. An unknown `ULTIMATE_ENV` names
 * nothing (`tryResolveEnvironment`): the boot refuses it first, and doctor must not crash on it.
 */
export const namedDeployed = (env: EnvTable): boolean => {
  const environment = tryResolveEnvironment({ env });
  return environment === 'staging' || environment === 'production';
};

/**
 * What the app's `app.config.ts` decides about which framework keys it owes — read by the caller,
 * which has the root (`appSecretFacts`). `x doctor` asks of no config and passes `NO_APP_FACTS`.
 */
export interface AppSecretFacts {
  /** `pwa.enabled && pwa.push`: the boot resolves a VAPID pair and refuses without one. */
  readonly push: boolean;
}

export const NO_APP_FACTS: AppSecretFacts = Object.freeze({ push: false });

/** One framework secret: what refuses without it, when it is needed, and the command that mints one. */
export interface FrameworkSecret {
  readonly key: string;
  /** The diagnostic code `x doctor` and `x env check` report it under. */
  readonly code: 'X_CURSOR_SECRET_DEV' | 'X_STORAGE_SECRET_DEV' | 'X_PWA_VAPID_KEY_MISSING';
  /** False for the one key here that is public (the VAPID public key). Default true. */
  readonly secret?: boolean;
  /** Why the framework needs it, one line, rendered into `.env.example`. */
  readonly why: string;
  /** When the key is needed at all, if not always — rendered beside `why`. */
  readonly condition?: string;
  readonly cause: string;
  /** Pasted into a shell, so it is a literal command and never a paraphrase. */
  readonly fix: string;
  /**
   * What `app.config.ts` must say for the key to be owed AT ALL — the VAPID pair, only with
   * `pwa.push`. Absent: always. The ONE rule the example, the drift gate and `x env check` read
   * (`configOwes`), so a second config-gated key is one line here, never two filters elsewhere.
   */
  readonly owedWhen?: (app: AppSecretFacts) => boolean;
  /** False when this deploy's shape never reads the key (object storage configured, push off). */
  needed(env: EnvTable, app: AppSecretFacts): boolean;
  /** True while the table would leave the process signing with the shipped development key. */
  unsafe(env: EnvTable): boolean;
}

/** In declaration order — the order `.env.example` renders them in. */
export const FRAMEWORK_SECRETS: readonly FrameworkSecret[] = [
  {
    key: CURSOR_SECRET_KEY,
    code: 'X_CURSOR_SECRET_DEV',
    why: 'Signs pagination cursors. Unset, every role refuses to boot (X_CURSOR_SECRET_DEV).',
    cause:
      'cursors are signed with the shipped development key, so a client can forge a page position',
    // Core's, verbatim: the boot's own refusal prints this line for this code.
    fix: CURSOR_SECRET_FIX,
    needed: () => true,
    unsafe: (env) => usesDevCursorSecret({ env }),
  },
  {
    key: STORAGE_SIGNING_SECRET_KEY,
    code: 'X_STORAGE_SECRET_DEV',
    why: 'Signs upload grants on the embedded disk. Unset, every role refuses to boot (X_ENV_MISSING).',
    condition: 'Not read when S3_ENDPOINT and S3_BUCKET select object storage.',
    cause: `${STORAGE_SIGNING_SECRET_KEY} is unset or holds the shipped development key, so a local-disk deploy would accept forged upload grants that override its own uploadPolicy`,
    fix: `export ${STORAGE_SIGNING_SECRET_KEY}="$(openssl rand -hex 32)"`,
    // The boot's own storage choice (`runtime-bindings.ts`), never restated. NOT "the app declares
    // no storage": the boot builds its disk before any app module loads, and an app reaches it
    // through a bare `disk()` with no `defineStorage` of its own
    // (`examples/dummy/apps/web/app/orgs/avatar.ts`), so there is no declaration to read.
    needed: (env) => !storageIsExternal(env),
    unsafe: (env) => usesDevStorageSecret({ env }),
  },
  // The VAPID pair, owed only once `pwa.push` is on. Both halves are env (never config) and are
  // sealed together by `x vapid create`, so the fix is that one command for either half.
  {
    key: VAPID_PUBLIC_KEY_ENV,
    code: 'X_PWA_VAPID_KEY_MISSING',
    secret: false,
    why: 'Web Push public key, written into every page as <meta name="x-push-key">. Generate the pair with `x vapid create`.',
    condition: 'Read only when pwa.push is true.',
    cause: `${VAPID_PUBLIC_KEY_ENV} is unset, so a push-enabled deploy refuses to boot (X_PWA_VAPID_KEY_MISSING)`,
    fix: 'x vapid create',
    owedWhen: (app) => app.push,
    needed: (_env, app) => app.push,
    unsafe: (env) => (env[VAPID_PUBLIC_KEY_ENV] ?? '').trim() === '',
  },
  {
    key: VAPID_PRIVATE_KEY_ENV,
    code: 'X_PWA_VAPID_KEY_MISSING',
    why: 'Signs every Web Push request (RFC 8292). Generate the pair with `x vapid create`.',
    condition: 'Read only when pwa.push is true.',
    cause: `${VAPID_PRIVATE_KEY_ENV} is unset or holds the published development key, so a push-enabled deploy refuses to boot`,
    fix: 'x vapid create',
    owedWhen: (app) => app.push,
    needed: (_env, app) => app.push,
    unsafe: (env) => usesDevVapidKeys(env),
  },
];

/** Whether this app's config owes `secret` at all — `owedWhen`, else always. */
export const configOwes = (secret: FrameworkSecret, app: AppSecretFacts): boolean =>
  secret.owedWhen?.(app) ?? true;

/** The doctor/check finding for one secret — one wording per condition, wherever it is reported. */
export function frameworkSecretFinding(secret: FrameworkSecret): Finding {
  return { code: secret.code, cause: secret.cause, fix: secret.fix, docs: ERROR_DOCS_URL };
}

/** Every secret this table's deploy shape needs and lacks, ungated. */
const owedFindings = (
  env: EnvTable,
  skip: ReadonlySet<string>,
  app: AppSecretFacts,
): readonly Finding[] =>
  FRAMEWORK_SECRETS.filter(
    (secret) => !skip.has(secret.key) && secret.needed(env, app) && secret.unsafe(env),
  ).map((secret) => ({ ...frameworkSecretFinding(secret), at: ENV_EXAMPLE_PATH }));

/**
 * `x env check`'s: what a process booting on this table would refuse — gated by `deployed`, the
 * boot's rule, so an unnamed table owes what production owes. `skip` names keys the caller already
 * reported under another code, so one key is one finding. Throws `X_ENVIRONMENT_INVALID` on an
 * unknown `ULTIMATE_ENV`, as the boot does.
 */
export function frameworkSecretFindings(
  env: EnvTable,
  skip: ReadonlySet<string> = new Set(),
  app: AppSecretFacts = NO_APP_FACTS,
): readonly Finding[] {
  return deployed(env) ? owedFindings(env, skip, app) : [];
}

/** `x doctor`'s: the same list and wording, gated by `namedDeployed` — this machine, as named. */
export function machineSecretFindings(
  env: EnvTable,
  app: AppSecretFacts = NO_APP_FACTS,
): readonly Finding[] {
  return namedDeployed(env) ? owedFindings(env, new Set(), app) : [];
}

/**
 * The framework's section of `.env.example`, after the app's own. A key the app's schema already
 * declares is skipped: one key, one line, and the app's declaration is the one it validates.
 * Blank values only — these are secrets, and this file is committed.
 */
function frameworkSection(schema: EnvSchema, app: AppSecretFacts): string {
  // `needed` against an empty table: the example names what a deploy of THIS app owes, so the
  // config decides (push on or off) and no environment does — object storage is a deploy's choice,
  // and the disk secret stays listed with its condition.
  const owed = FRAMEWORK_SECRETS.filter(
    (secret) => !Object.hasOwn(schema, secret.key) && configOwes(secret, app),
  );
  if (owed.length === 0) return '';
  // Each key names its own generator: `openssl` mints a hex secret, and a VAPID pair minted that
  // way is one the boot refuses — only `x vapid create` makes a P-256 pair. `x doctor` asks of no
  // config, so it never reports the pair; `x env check` reports every one.
  const pair = owed.some((secret) => secret.owedWhen !== undefined);
  const lines = [
    '',
    '# --- Framework ---------------------------------------------------------------',
    ...(pair
      ? [
          '# Required outside development/test, whatever envSchema declares. Generate the hex',
          '# secrets with `openssl rand -hex 32` and the VAPID pair with `x vapid create`;',
          '# `x env check` reports one that is missing.',
        ]
      : [
          '# Required outside development/test, whatever envSchema declares. Generate each with',
          '# `openssl rand -hex 32`; `x env check` and `x doctor` report one that is missing.',
        ]),
  ];
  for (const secret of owed) {
    lines.push('', `# ${secret.why}`);
    if (secret.condition !== undefined) lines.push(`# ${secret.condition}`);
    lines.push(
      `# required when deployed · string${secret.secret === false ? '' : ' · secret'}`,
      `${secret.key}=`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The bytes `.env.example` must hold: the app's declaration, then the framework's keys. The ONE
 * renderer `x env example`, the drift gate and `x new` share, so the three cannot disagree.
 */
export const appEnvExample = (schema: EnvSchema, app: AppSecretFacts = NO_APP_FACTS): string =>
  `${renderEnvExample(schema)}${frameworkSection(schema, app)}`;
