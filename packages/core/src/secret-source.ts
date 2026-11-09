// Single responsibility: WHERE the master key comes from — the `secretSource` adapter port. Two
// sources are built in (the env var, the key file) and the default asks them in that order; a KMS or
// Vault lookup is an app-written `SecretSource` installed from `apps/<app>/runtime.ts`.

// why: Bun has no synchronous file read or exists check; the built-in file source is read at boot.
import { existsSync, readFileSync } from 'node:fs';
// Bun exposes no path-join primitive.
import { join } from 'node:path';
import { adapterSlot } from './adapter-slot';

/** Never committed — `x secrets init` writes the ignore rule before it writes this. */
export const SECRETS_KEY_FILE = '.secrets.key';
/** Read first, so a container gets its key from the platform's secret store and never from a file. */
export const SECRETS_KEY_ENV = 'ULTIMATE_SECRETS_KEY';

export const masterKeyPath = (root: string): string => join(root, SECRETS_KEY_FILE);

export interface MasterKeyRef {
  readonly hex: string;
  /** The `name` of the source that found it: `'env'`, `'file'`, or an app's own (`'kms'`). */
  readonly source: string;
  /** Where it was read — a variable name, a path, a key ARN — for an error's `cause`. Never the key. */
  readonly at: string;
}

type EnvRecord = Readonly<Record<string, string | undefined>>;

export interface SecretSourceContext {
  /** The app root holding `secrets.enc.json` (and, for the file source, `.secrets.key`). */
  readonly root: string;
  readonly env: EnvRecord;
}

/**
 * The port. Answers the master key or `undefined` when it has none — never throws for "absent":
 * the caller owns the refusal (`X_SECRETS_KEY_MISSING`), so every source fails the same way.
 * Async allowed: a KMS decrypt or a Vault read is a network call.
 */
export interface SecretSource {
  /** Stable label, carried as `MasterKeyRef.source` and in `installSecrets()`'s report. */
  readonly name: string;
  masterKey(
    context: SecretSourceContext,
  ): MasterKeyRef | undefined | Promise<MasterKeyRef | undefined>;
}

function fromEnv({ env }: SecretSourceContext): MasterKeyRef | undefined {
  const hex = env[SECRETS_KEY_ENV]?.trim();
  return hex === undefined || hex.length === 0
    ? undefined
    : { hex, source: 'env', at: SECRETS_KEY_ENV };
}

function fromFile({ root }: SecretSourceContext): MasterKeyRef | undefined {
  const path = masterKeyPath(root);
  if (!existsSync(path)) return undefined;
  return { hex: readFileSync(path, 'utf-8').trim(), source: 'file', at: path };
}

/** The env var — what one image running everywhere is handed by its platform. */
export const envSecretSource: SecretSource = Object.freeze({ name: 'env', masterKey: fromEnv });

/** The gitignored key file a checkout has. */
export const fileSecretSource: SecretSource = Object.freeze({ name: 'file', masterKey: fromFile });

/**
 * Env var first, key file second — what makes one image run everywhere: a container is handed
 * `ULTIMATE_SECRETS_KEY` and ships no key file, a checkout has the file and exports nothing.
 * Synchronous, because both built-ins are: `findMasterKey` and `x doctor` read it without a boot.
 */
export const builtInMasterKey = (context: SecretSourceContext): MasterKeyRef | undefined =>
  fromEnv(context) ?? fromFile(context);

export const defaultSecretSource: SecretSource = Object.freeze({
  name: 'default',
  masterKey: builtInMasterKey,
});

const installed = adapterSlot<SecretSource>(() => defaultSecretSource);

/** The source in force. `installSecrets()` and the seal ring both ask it, never a built-in directly. */
export const secretSource = (): SecretSource => installed.current();

/**
 * The installer — on `@ultimat3/core/adapter`, never the barrel: the boot calls it with
 * `runtime.ts`'s `secretSource` BEFORE `app.config.ts` evaluates `installSecrets()`, and
 * `@ultimat3/testing` for one test. Returns the release, which removes this install alone (`adapter-slot.ts`).
 */
export function installSecretSource(next: SecretSource): () => void {
  resolved.clear();
  const release = installed.install(next);
  return () => {
    resolved.clear();
    release();
  };
}

/**
 * An app source's answer, per root, for as long as that source is installed. A KMS decrypt or a
 * Vault read is a network round trip, and the seal ring asks on every sealed read and write — so
 * fifty seals were fifty calls. Only a FOUND key is kept: `undefined` and a rejection are asked
 * again next time. The built-in default is never cached: it is two local reads, and `x secrets
 * rotate` renaming a new key file must be seen on the very next call.
 */
const resolved = new Map<string, Promise<MasterKeyRef | undefined>>();

/** The installed source's answer for this root and environment. */
export async function resolveMasterKey(
  root: string,
  env: EnvRecord,
): Promise<MasterKeyRef | undefined> {
  const source = installed.current();
  if (source === defaultSecretSource) return source.masterKey({ root, env });
  const cached = resolved.get(root);
  if (cached !== undefined) return cached;
  const pending = Promise.resolve(source.masterKey({ root, env }));
  resolved.set(root, pending);
  const forget = (): void => {
    if (resolved.get(root) === pending) resolved.delete(root);
  };
  pending.then((key) => {
    if (key === undefined) forget();
  }, forget);
  return pending;
}
