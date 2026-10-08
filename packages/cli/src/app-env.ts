// The app's typed environment as the CLI sees it: the `defineEnv` declaration read back out of
// `app.config.ts`, the `.env.example` projected from it, and the drift between the two. One
// declaration, both files (axiom 2) — nothing here holds a second list of variable names.

// why: Bun exposes no path API — the two files this module reads are joined to the app root.
import { join } from 'node:path';
import type { EnvSchema, EnvVarDecl } from '@ultimat3/core';
import { ENV_EXAMPLE_PATH, ERROR_DOCS_URL, parseEnvKeys } from '@ultimat3/core';
import { appConfigExport, loadAppConfig } from './app-config-load';
import { APP_CONFIG_FILE } from './app-root';
import type { AppSecretFacts } from './framework-env';
import { appEnvExample, FRAMEWORK_SECRETS } from './framework-env';
import type { Finding } from './output';
import { findingFrom } from './output';

/**
 * The one export name the CLI looks for. `defineEnv()` returns the resolved VALUES, so the
 * declaration it validated is unreachable from its result — an app that wants `.env.example`,
 * `x env check` and the drift gate names the record it passed in:
 *
 * ```ts
 * export const envSchema = { DATABASE_URL: { type: 'url', … } } satisfies EnvSchema;
 * export const env = defineEnv(envSchema);
 * ```
 *
 * An app that exports no `envSchema` declares no environment, so there is nothing to project and
 * nothing to drift — every check here reports nothing rather than inventing a requirement.
 */
export const ENV_SCHEMA_EXPORT = 'envSchema';

const ENV_TYPES = new Set(['string', 'url', 'number', 'integer', 'port', 'boolean', 'enum']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isDecl = (value: unknown): value is EnvVarDecl =>
  isRecord(value) && typeof value['type'] === 'string' && ENV_TYPES.has(value['type']);

/** Structural, not `instanceof`: the schema is a plain record the app authored, never a class. */
export const isEnvSchema = (value: unknown): value is EnvSchema =>
  isRecord(value) && Object.values(value).every(isDecl);

/**
 * The declaration `app.config.ts` exports, through the one loader (`app-config-load.ts`).
 * `undefined` means "this root declares no environment"; a config that will not import throws, and
 * the caller turns that into the finding.
 */
export async function loadEnvSchema(root: string): Promise<EnvSchema | undefined> {
  const declared = await appConfigExport(root, ENV_SCHEMA_EXPORT);
  return isEnvSchema(declared) ? declared : undefined;
}

/**
 * The bytes `.env.example` must hold: the app's declaration, then the framework's deploy-required
 * keys (`framework-env.ts`). Deterministic, so a rewrite that changes nothing diffs to nothing.
 */
export const envExampleFor = (schema: EnvSchema, app: AppSecretFacts): string =>
  appEnvExample(schema, app);

/**
 * What `app.config.ts` decides about the framework keys this app owes — `pwa.push` today, off the
 * one loader, so the example, the drift gate and `x env check` read one answer.
 */
export async function appSecretFacts(root: string): Promise<AppSecretFacts> {
  const pwa = (await loadAppConfig(root))?.pwa;
  return { push: pwa?.enabled === true && pwa.push };
}

const driftFinding = (cause: string): Finding => ({
  code: 'X_ENV_EXAMPLE_DRIFT',
  cause,
  // The generator, never a `Bun.write(…)` call: that needs a schema object in scope, and a gate
  // reader has a shell.
  fix: 'x env example',
  docs: ERROR_DOCS_URL,
  at: ENV_EXAMPLE_PATH,
});

/**
 * The gate half. Byte-exact against the projection, not just "every key is present somewhere":
 * the example carries each variable's description, whether it is required and its default, and a
 * key-only rule would let all three rot while the file still passed. Missing keys are still called
 * out by name first, because that is the failure a reader can act on without diffing.
 */
export async function envExampleFindings(root: string): Promise<readonly Finding[]> {
  let schema: EnvSchema | undefined;
  try {
    schema = await loadEnvSchema(root);
  } catch (error) {
    return [{ ...findingFrom(error), at: APP_CONFIG_FILE }];
  }
  if (schema === undefined) return [];
  const app = await appSecretFacts(root);
  const expected = envExampleFor(schema, app);
  const file = Bun.file(join(root, ENV_EXAMPLE_PATH));
  if (!(await file.exists())) {
    return [
      driftFinding(
        `${ENV_EXAMPLE_PATH} does not exist and ${ENV_SCHEMA_EXPORT} declares ${Object.keys(schema).length} variable(s)`,
      ),
    ];
  }
  const text = await file.text();
  if (text === expected) return [];
  const present = new Set(parseEnvKeys(text));
  const missing = Object.keys(schema).filter((key) => !present.has(key));
  // The framework's keys are owed by every deployed app, whatever its schema says (#679), and an
  // example written before they were part of the contract is missing exactly these.
  const owed = FRAMEWORK_SECRETS.filter(
    (secret) => secret.code !== 'X_PWA_VAPID_KEY_MISSING' || app.push,
  )
    .map((secret) => secret.key)
    .filter((key) => !Object.hasOwn(schema, key) && !present.has(key));
  return [
    driftFinding(
      missing.length > 0
        ? `${ENV_EXAMPLE_PATH} does not declare ${missing.join(', ')}, declared by ${ENV_SCHEMA_EXPORT} in ${APP_CONFIG_FILE}`
        : owed.length > 0
          ? `${ENV_EXAMPLE_PATH} does not declare ${owed.join(', ')}, which the framework refuses to boot without outside development/test`
          : `${ENV_EXAMPLE_PATH} is no longer the projection of ${ENV_SCHEMA_EXPORT} — a description, a default or the required flag has moved`,
    ),
  ];
}
