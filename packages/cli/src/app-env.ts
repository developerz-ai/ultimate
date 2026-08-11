// The app's typed environment as the CLI sees it: the `defineEnv` declaration read back out of
// `app.config.ts`, the `.env.example` projected from it, and the drift between the two. One
// declaration, both files (axiom 2) — nothing here holds a second list of variable names.

// Bun ships no equivalent: `existsSync` answers whether this root is an app, `join` builds the
// host-separator path to the two files this module reads.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EnvSchema, EnvVarDecl } from '@ultimat3/core';
import { checkEnvExample, ENV_EXAMPLE_PATH, renderEnvExample } from '@ultimat3/core';
import { APP_CONFIG_FILE } from './app-root';
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
 * Import `app.config.ts` and hand back the declaration it exports. Importing is the only honest
 * way to read it — the alternative is a regex over the app's source, which is the pattern
 * `app-load.ts` exists to refuse. `undefined` means "this root declares no environment"; a config
 * that will not import throws, and the caller turns that into the finding.
 */
export async function loadEnvSchema(root: string): Promise<EnvSchema | undefined> {
  const configPath = join(root, APP_CONFIG_FILE);
  if (!existsSync(configPath)) return undefined;
  const module = (await import(configPath)) as Record<string, unknown>;
  const declared = module[ENV_SCHEMA_EXPORT];
  if (declared === undefined) return undefined;
  return isEnvSchema(declared) ? declared : undefined;
}

/** The bytes `.env.example` must hold. Deterministic, so a rewrite that changes nothing diffs to nothing. */
export const envExampleFor = (schema: EnvSchema): string => renderEnvExample(schema);

const driftFinding = (cause: string): Finding => ({
  code: 'X_ENV_EXAMPLE_DRIFT',
  cause,
  // The generator, not the assertion: `assertEnvExample`'s own fix is a `Bun.write(…)` call for
  // an app that has a schema object in scope, and a gate reader has a shell.
  fix: 'x env example',
  docs: 'https://ultimate.dev/errors/X_ENV_EXAMPLE_DRIFT',
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
  const expected = envExampleFor(schema);
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
  const report = checkEnvExample(schema, text);
  return [
    driftFinding(
      report.missing.length > 0
        ? `${ENV_EXAMPLE_PATH} does not declare ${report.missing.join(', ')}, declared by ${ENV_SCHEMA_EXPORT} in ${APP_CONFIG_FILE}`
        : `${ENV_EXAMPLE_PATH} is no longer the projection of ${ENV_SCHEMA_EXPORT} — a description, a default or the required flag has moved`,
    ),
  ];
}
