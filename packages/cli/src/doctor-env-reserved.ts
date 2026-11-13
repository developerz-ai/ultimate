// `x doctor`'s env-name check: an app's own variable — declared in `envSchema` or sealed in the
// secrets file — on a name the framework also reads as a switch or for itself (`FRAMEWORK_ENV`).
// An adopter's sealed Cloudflare token switched the CDN purge on; nothing said the name was taken.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import type { FrameworkEnvName } from '@ultimat3/core';
import {
  APP_CONFIG_FILE,
  ERROR_DOCS_URL,
  findMasterKey,
  frameworkEnvEntry,
  readSecretsFile,
  secretsFileExists,
} from '@ultimat3/core';
import { ENV_SCHEMA_EXPORT, loadEnvSchema } from './app-env';
import type { Finding } from './output';

/** Where the app names its variables: what it declared, and what it sealed. */
export interface AppEnvNamesFact {
  readonly declared: readonly string[];
  /** The 1-based line of each declared key in `app.config.ts`, where the probe found one. */
  readonly lines?: ReadonlyMap<string, number>;
  /** Names in `secrets.enc.json`; empty when this machine has no key to open it with. */
  readonly sealed: readonly string[];
}

export const NO_APP_ENV_NAMES: AppEnvNamesFact = Object.freeze({ declared: [], sealed: [] });

export const ENV_NAME_RESERVED = 'X_ENV_NAME_RESERVED';

/** The prefix a renamed key takes: no framework entry starts with it. */
export const APP_ENV_PREFIX = 'APP_';

/**
 * A collision is a name the framework reads as a `switch` (its presence turns a behaviour on) or
 * `internal` (the framework sets it, or a harness does). The deploy contract (`DATABASE_URL`,
 * `PORT`) is what an app is meant to declare, and a `host` name is the platform's.
 */
const collides = (name: string): FrameworkEnvName | undefined => {
  const entry = frameworkEnvEntry(name);
  return entry !== undefined && (entry.use === 'switch' || entry.use === 'internal')
    ? entry
    : undefined;
};

const what = (name: string, entry: FrameworkEnvName): string =>
  entry.use === 'switch'
    ? `@ultimat3/${entry.owner} also reads ${name}: set, it switches that package's behaviour on with this value`
    : `${entry.prefix === true ? `every ${entry.name}* name` : name} is @ultimat3/${entry.owner}'s own, set by the framework or its harness`;

/** The rule, pure. One finding per name, a sealed name and a declared one apart. */
export function reservedEnvFindings(fact: AppEnvNamesFact): readonly Finding[] {
  const findings: Finding[] = [];
  for (const name of [...new Set(fact.declared)].sort()) {
    const entry = collides(name);
    if (entry === undefined) continue;
    findings.push({
      code: ENV_NAME_RESERVED,
      cause: `${ENV_SCHEMA_EXPORT} in ${APP_CONFIG_FILE} declares ${name}, and ${what(name, entry)}`,
      // A rename, never an allow: a name meant for the framework needs no app declaration at all.
      fix: `edit ${APP_CONFIG_FILE}:${fact.lines?.get(name) ?? 1} — rename ${name} in ${ENV_SCHEMA_EXPORT} to ${APP_ENV_PREFIX}${name} (or delete it where the value is meant for @ultimat3/${entry.owner}); then: x env example --json && x doctor --json`,
      docs: ERROR_DOCS_URL,
      at: APP_CONFIG_FILE,
    });
  }
  for (const name of [...new Set(fact.sealed)].sort()) {
    const entry = collides(name);
    if (entry === undefined) continue;
    findings.push({
      code: ENV_NAME_RESERVED,
      cause: `secrets.enc.json seals ${name}, and ${what(name, entry)}`,
      fix: `x secrets edit   # rename ${name} to ${APP_ENV_PREFIX}${name} unless the value is meant for @ultimat3/${entry.owner}; then: x doctor --json`,
      docs: ERROR_DOCS_URL,
      at: 'secrets.enc.json',
    });
  }
  return findings;
}

/**
 * The I/O half. A config that will not import, or a secrets file this key cannot open, is another
 * probe's finding (`snapshots`, `sealedKeys`); here it is simply nothing to judge.
 */
export async function appEnvNamesProbe(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<AppEnvNamesFact> {
  const declared = await loadEnvSchema(root).then(
    (schema) => Object.keys(schema ?? {}),
    () => [],
  );
  const config = await Bun.file(join(root, APP_CONFIG_FILE))
    .text()
    .catch(() => '');
  const lines = new Map<string, number>();
  // A key that is not a plain identifier is never a framework name, and never a regex here.
  for (const name of declared.filter((key) => /^[A-Za-z_]\w*$/.test(key))) {
    const at = config.search(new RegExp(`^\\s*['"]?${name}['"]?\\s*:`, 'm'));
    if (at >= 0) lines.set(name, config.slice(0, at).split('\n').length);
  }
  const key = findMasterKey(root, { ...env });
  const sealed =
    key === undefined || !secretsFileExists(root)
      ? []
      : await readSecretsFile(root, key).then(
          (values) => Object.keys(values),
          () => [],
        );
  return { declared, lines, sealed };
}
