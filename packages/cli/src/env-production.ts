// Single responsibility: the `.env.production` `x env init --production` writes, as text. Pure:
// the caller hands in the app's env declaration, its compose file and the randomness, so a test
// can read every line without a filesystem or a real secret.

import type { EnvSchema, EnvVarDecl } from '@ultimat3/core';
import { VAPID_PRIVATE_KEY_ENV, VAPID_PUBLIC_KEY_ENV } from '@ultimat3/pwa';
import { composeDatabase, composeRequiredVars, DEFAULT_IMAGE } from './cmd-deploy-compose';
import { type AppSecretFacts, configOwes, FRAMEWORK_SECRETS } from './framework-env';

/** The two origins one box serves on: the pages on :3000, the sync socket on :3001. */
export const LOCAL_ORIGINS: Readonly<Record<string, string>> = {
  APP_URL: 'http://localhost:3000',
  SYNC_URL: 'ws://localhost:3001/_x/sync',
};

export interface ProductionEnvInput {
  readonly schema: EnvSchema;
  /** `docker/docker-compose.prod.yml`'s text, or `undefined` when the app has none. */
  readonly compose: string | undefined;
  readonly facts: AppSecretFacts;
  /** One fresh secret per call: 32 random bytes as hex, `openssl rand -hex 32`'s shape. */
  readonly secret: () => string;
  /** The Web Push pair, minted by the caller only when `facts.push` owes one. */
  readonly vapid?: { readonly publicKey: string; readonly privateKey: string } | undefined;
}

export interface ProductionEnv {
  readonly contents: string;
  /** Every key written with a value, in file order. Names only: the values are secrets. */
  readonly written: readonly string[];
  /** Keys the file must carry and nothing here can know: written empty, for the operator. */
  readonly unfilled: readonly string[];
}

/** Required at boot: no default and no `required: false`. A role-scoped key is required there. */
export const requiredAtBoot = (decl: EnvVarDecl): boolean =>
  decl.default === undefined && decl.required !== false;

/**
 * The file. Order is the reader's: the environment, the image, the database, the origins, then
 * every secret, and last the keys left for the operator, each under the description that says
 * what it is.
 */
export function productionEnvFile(input: ProductionEnvInput): ProductionEnv {
  const values = new Map<string, string>([
    ['ULTIMATE_ENV', 'production'],
    ['IMAGE', DEFAULT_IMAGE],
  ]);
  const required = input.compose === undefined ? [] : composeRequiredVars(input.compose);
  const db = composeDatabase(input.compose);
  if (db !== undefined) {
    const password = input.secret();
    values.set('POSTGRES_PASSWORD', password);
    values.set(
      'DATABASE_URL',
      `postgres://${encodeURIComponent(db.user)}:${password}@db:5432/${encodeURIComponent(db.database)}`,
    );
  }
  for (const [key, origin] of Object.entries(LOCAL_ORIGINS)) {
    if (required.includes(key) || Object.hasOwn(input.schema, key)) values.set(key, origin);
  }
  for (const [key, decl] of Object.entries(input.schema)) {
    if (decl.secret === true && !values.has(key)) values.set(key, input.secret());
  }
  for (const owed of FRAMEWORK_SECRETS) {
    if (!configOwes(owed, input.facts) || values.has(owed.key)) continue;
    if (owed.key === VAPID_PUBLIC_KEY_ENV && input.vapid !== undefined) {
      values.set(owed.key, input.vapid.publicKey);
    } else if (owed.key === VAPID_PRIVATE_KEY_ENV && input.vapid !== undefined) {
      values.set(owed.key, input.vapid.privateKey);
    } else if (owed.secret !== false) {
      values.set(owed.key, input.secret());
    }
  }
  const unfilled = [
    ...Object.entries(input.schema)
      .filter(([key, decl]) => requiredAtBoot(decl) && !values.has(key))
      .map(([key]) => key),
    ...required.filter((key) => !values.has(key) && !Object.hasOwn(input.schema, key)),
  ];
  const lines = [
    '# Written by `x env init --production`. Secrets: never commit this file (.gitignore covers it),',
    '# and keep a copy in a secret store — a new POSTGRES_PASSWORD does not reach a database that',
    '# already initialised its volume with the old one.',
    '# APP_URL and SYNC_URL are this box on localhost: set the host your users reach.',
    ...[...values].map(([key, value]) => `${key}=${value}`),
    ...unfilled.flatMap((key) => [
      `# required: ${input.schema[key]?.description ?? 'the compose file refuses to parse without it'}`,
      `${key}=`,
    ]),
  ];
  return { contents: `${lines.join('\n')}\n`, written: [...values.keys()], unfilled };
}
