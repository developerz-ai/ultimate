// Single responsibility: where the two secrets files live, how the master key is found, and the
// ONE path from a decrypted value to a `defineEnv`-declared variable — `installSecrets()` writes
// each value into the process environment, under its own name, only where the real environment has
// nothing. `secrets.ts` owns the envelope; this owns the filesystem and `process.env`.

// `node:fs` sync, by necessity twice over: Bun.write takes no mode, and a world-readable master key
// is the whole failure this file exists to prevent — and `installSecrets()` runs once, at boot,
// before the process is serving anything, so there is nothing for an async read to overlap with.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
// Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { SecretValues } from './secrets';
import { masterKeyId, openSecrets, parseMasterKey, sealSecrets } from './secrets';
import { SecretsFileMissingError, SecretsKeyMissingError } from './secrets-errors';

/** Committed. Encrypted at rest, diffable, and the only file `x secrets` writes into the repo. */
export const SECRETS_FILE = 'secrets.enc.json';
/** Never committed — `x secrets init` writes the ignore rule before it writes this. */
export const SECRETS_KEY_FILE = '.secrets.key';
/** Read first, so a container gets its key from the platform's secret store and never from a file. */
export const SECRETS_KEY_ENV = 'ULTIMATE_SECRETS_KEY';
/** Owner read/write. A key file the rest of the box can read is a key file that has leaked. */
export const SECRETS_KEY_MODE = 0o600;

export type MasterKeySource = 'env' | 'file';

export interface MasterKeyRef {
  readonly hex: string;
  readonly source: MasterKeySource;
  /** The env var name or the file path, for an error's `cause` — never the key itself. */
  readonly at: string;
}

type EnvRecord = Record<string, string | undefined>;

export const secretsPath = (root: string): string => join(root, SECRETS_FILE);
export const masterKeyPath = (root: string): string => join(root, SECRETS_KEY_FILE);
export const secretsFileExists = (root: string): boolean => existsSync(secretsPath(root));

/**
 * Env var first, key file second. That order is what makes one image run everywhere: a container
 * is handed `ULTIMATE_SECRETS_KEY` and never ships a key file, while a checkout has the file and
 * needs no exported variable.
 */
export function findMasterKey(
  root: string,
  env: EnvRecord = process.env,
): MasterKeyRef | undefined {
  const fromEnv = env[SECRETS_KEY_ENV];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return { hex: fromEnv.trim(), source: 'env', at: SECRETS_KEY_ENV };
  }
  const path = masterKeyPath(root);
  if (!existsSync(path)) return undefined;
  return { hex: readFileSync(path, 'utf-8').trim(), source: 'file', at: path };
}

export function requireMasterKey(root: string, env: EnvRecord = process.env): MasterKeyRef {
  const found = findMasterKey(root, env);
  if (found !== undefined) return found;
  throw new SecretsKeyMissingError({ envVar: SECRETS_KEY_ENV, keyPath: masterKeyPath(root) });
}

/** The key's public id. Safe to print, safe to commit — it is what names a rotation in a diff. */
export const masterKeyIdOf = (key: MasterKeyRef): Promise<string> =>
  masterKeyId(parseMasterKey(key.hex, key.at));

/** Decrypt the committed file. `X_SECRETS_FILE_MISSING` when there is none — never an empty map. */
export async function readSecretsFile(root: string, key: MasterKeyRef): Promise<SecretValues> {
  const path = secretsPath(root);
  if (!existsSync(path)) throw new SecretsFileMissingError({ at: path });
  return openSecrets(readFileSync(path, 'utf-8'), key.hex, { file: path, key: key.at });
}

/** Seal and commit. The only writer of `secrets.enc.json`; plaintext never reaches this path. */
export async function writeSecretsFile(
  root: string,
  values: SecretValues,
  key: MasterKeyRef,
): Promise<string> {
  const path = secretsPath(root);
  await Bun.write(path, await sealSecrets(values, key.hex, { file: path, key: key.at }));
  return path;
}

/** Write the master key at 0600. Callers must have made the ignore rule true first. */
export function writeMasterKeyFile(root: string, keyHex: string): string {
  const path = masterKeyPath(root);
  writeFileSync(path, `${keyHex}\n`, { encoding: 'utf-8', mode: SECRETS_KEY_MODE });
  return path;
}

export interface SecretsInstallOptions {
  /** The app root holding `secrets.enc.json`. Defaults to the process's working directory. */
  readonly root?: string | undefined;
  /** Read for the key and written with the values. Defaults to `process.env`. */
  readonly env?: EnvRecord | undefined;
}

/** Names only. A report that carried a value would be a secret in every log that printed it. */
export interface SecretsInstallReport {
  readonly present: boolean;
  readonly path: string;
  readonly keySource: MasterKeySource | undefined;
  readonly keyId: string | undefined;
  /** Variables this call set. */
  readonly installed: readonly string[];
  /** Variables the real environment already supplied, so the file's value was not used. */
  readonly skipped: readonly string[];
}

/**
 * Decrypt the committed secrets into the environment, then let `defineEnv` do what it already does.
 *
 * ```ts
 * await installSecrets();                                   // app.config.ts, first line
 * export const envSchema = { SESSION_SECRET: { type: 'string', secret: true } } satisfies EnvSchema;
 * export const env = defineEnv(envSchema);
 * ```
 *
 * This is the whole integration, and it is one path rather than two on purpose. A secret has one
 * name — the env var it becomes — so it keeps one declaration (`envSchema`), one row in
 * `.env.example`, one masker (`maskedEnvValues`), one redaction entry (`redactKeys`) and one
 * reader (`env.SESSION_SECRET`). A `secrets.get('…')` accessor would mint values with no
 * declaration, no type and no mask, and every one of those five would need a second implementation.
 *
 * The real environment always wins: a platform-injected `DATABASE_URL` beats the committed file, so
 * the same image runs in Compose and K8s without a second secrets file per deploy. A file that does
 * not exist is not an error — an app may declare no secrets — but a file that exists with no key to
 * open it is `X_SECRETS_KEY_MISSING`, because booting past it produces an app that authenticates
 * against nothing and reports itself healthy.
 *
 * Forgetting the `await` fails loudly rather than silently: `defineEnv` runs first and throws
 * `X_ENV_MISSING` naming every variable the file would have supplied.
 */
export async function installSecrets(
  options: SecretsInstallOptions = {},
): Promise<SecretsInstallReport> {
  const root = options.root ?? process.cwd();
  const env = options.env ?? (process.env as EnvRecord);
  const path = secretsPath(root);
  if (!existsSync(path)) {
    return {
      present: false,
      path,
      keySource: undefined,
      keyId: undefined,
      installed: [],
      skipped: [],
    };
  }
  const key = requireMasterKey(root, env);
  const values = await readSecretsFile(root, key);
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const current = env[name];
    if (current === undefined || current === '') {
      env[name] = value;
      installed.push(name);
    } else {
      skipped.push(name);
    }
  }
  return {
    present: true,
    path,
    keySource: key.source,
    keyId: await masterKeyIdOf(key),
    installed: installed.sort(),
    skipped: skipped.sort(),
  };
}
