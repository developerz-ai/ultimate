// The seam `runDoctor` reads instead of the environment, and the real one over this machine: every
// fact `x doctor` judges is reached through `DoctorProbe`, so every rule is testable with a stub.

// why: Bun has no synchronous file-exists or path-join API; the probe answers `exists` synchronously.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PGLITE_PACKAGE } from '@ultimat3/db';
import { loadApp } from './app-load';
import { IMPORT_UNRESOLVED } from './app-load-unresolved';
import { findAppRoot } from './app-root';
import { checkMigrationSnapshots } from './db-snapshot';
import { type AuthStorageFact, authStorageProbe } from './doctor-auth';
import type { EmbeddedDatabase } from './doctor-database';
import { externalUrl, installedAbove, probeDatabase } from './doctor-database';
import type { OfflineFallbackFact } from './doctor-offline';
import { offlineFallbackProbe } from './doctor-offline';
import type { PoolerFact } from './doctor-pooler';
import { poolerProbe } from './doctor-pooler';
import { rowSecurityProbe } from './doctor-row-security';
import type { SealedKeysFact } from './doctor-sealed';
import { sealedKeysProbe } from './doctor-sealed';
import { typescriptProbe } from './doctor-typescript';
import { machineSecretFindings } from './framework-env';
import type { Finding } from './output';
import { portFree } from './port-probe';
import { checkMigrationDrift } from './schema-drift';
import type { TypescriptLag } from './typescript-floor';

/**
 * The injection seam `runDoctor` reads instead of the environment. Not a semver surface —
 * `wiki/Upgrading.md` covers `X_*` codes, the eight primitive shapes, the `x` CLI surface, the
 * tier table and `app.config.ts` fields, and not this — so a new fact the probe must report is a
 * REQUIRED field: an optional one lets an implementation skip the check and still typecheck.
 */
export interface DoctorProbe {
  readonly bunVersion: string;
  /** App root, or undefined when the command runs outside an app. */
  readonly root: string | undefined;
  readonly port: number;
  /** `APP_URL` as this environment declares it; `undefined` when unset. */
  readonly appUrl: string | undefined;
  /**
   * The framework's own secrets this machine lacks — `framework-env.ts`'s
   * `machineSecretFindings`, gated by `namedDeployed`: only an environment NAMED staging or
   * production (an unnamed developer shell owes nothing; `x env check` is the fail-closed answer).
   * The list's own `needed`/`unsafe` decide; doctor reports.
   */
  readonly frameworkFindings: readonly Finding[];
  exists(relativePath: string): boolean;
  portFree(port: number): Promise<boolean>;
  /**
   * Is the configured database reachable, and what refused? `null` is "reachable, or there is
   * nothing external to reach" — an unset `DATABASE_URL` is embedded PGlite, which `x dev` owns
   * and which a probe would take the single-writer lock on.
   *
   * Until this existed `x doctor` answered "no findings — environment is shippable" against
   * `DATABASE_URL=postgres://nope:nope@localhost:5432/nope`, while `x db migrate` on the same env
   * correctly answered `X_DB_UNAVAILABLE` (#F5).
   */
  database(): Promise<Finding | null>;
  /**
   * Is the EMBEDDED database usable, and is it the one this environment would open? A FACT and not
   * a finding, the split `offlineFallback` makes below: reaching a module resolver is IO, and what
   * an unresolvable optional peer MEANS is a pure rule with a pure test.
   *
   * `database()` answers `null` the moment `DATABASE_URL` is unset — which is exactly a bare VM,
   * the configuration `x dev` invents a database FOR — so until this existed `x doctor` was silent
   * about the only database a fresh box has. `bin/setup` found out instead, at `x db migrate`.
   */
  embeddedDatabase(): Promise<EmbeddedDatabase>;
  drift(): Promise<readonly Finding[]>;
  /**
   * The other half of the migrations directory: a newest migration with no `.snapshot.json`, which
   * is what `x db gen` refuses on. Separate from `drift()` because they are separate questions with
   * separate remedies — one is "generate a migration", the other is "this migration is incomplete".
   */
  snapshots(): Promise<readonly Finding[]>;
  /**
   * What the app declared as its offline fallback, and which routes it really serves. A FACT and
   * not a finding, because deciding is `offlineFallbackFinding`'s and this seam's whole job is
   * reaching the disk — the same split `drift()` makes one question over.
   */
  offlineFallback(): Promise<OfflineFallbackFact>;
  /**
   * The app's `.sealed()` columns and the master keys this environment declares. A FACT, for the
   * reason `offlineFallback` is one: loading the app and opening the secrets file is IO, and what
   * a retired key beside a sealed column means is `sealedKeyFindings`' pure rule.
   */
  sealedKeys(): Promise<SealedKeysFact>;
  /**
   * What an upgrade left in the auth tables for an operator to finish: unsealed second-factor
   * secrets, and tables no release reads. Asked of an external database only.
   */
  authStorage(): Promise<AuthStorageFact>;
  /** The statement bound the session really reads, and what a pooler refused (`doctor-pooler.ts`). */
  pooler(): Promise<PoolerFact>;
  /** Each manifest whose `typescript` range lags the scaffold's (`doctor-typescript.ts`). */
  typescript(): Promise<readonly TypescriptLag[]>;
  /** With `database.rowSecurity` on, whether the serving role is exempt (`doctor-row-security.ts`). */
  rowSecurity?(): Promise<readonly Finding[]>;
}

export function probeFor(
  cwd: string,
  bunVersion: string,
  port: number,
  // The environment `doctorPort` read `PORT` from, so `APP_URL` is judged against the same one.
  env: Readonly<Record<string, string | undefined>> = process.env,
): DoctorProbe {
  const root = findAppRoot(cwd)?.dir;
  return {
    bunVersion,
    root,
    port,
    appUrl: env['APP_URL'],
    frameworkFindings: machineSecretFindings(env),
    exists: (relativePath) => (root === undefined ? false : existsSync(join(root, relativePath))),
    portFree,
    database: () => probeDatabase(process.env['DATABASE_URL'], env),
    // `root ?? cwd` because the walk needs a directory that exists; outside an app `runDoctor`
    // returns on `X_NOT_IN_APP` before this is ever asked, so the value only has to be honest.
    embeddedDatabase: async () => ({
      selected: externalUrl(process.env['DATABASE_URL']) === undefined,
      resolved: installedAbove(root ?? cwd, PGLITE_PACKAGE),
    }),
    drift: async () => (root === undefined ? [] : checkMigrationDrift(root)),
    // The import half too: `X_CLI_UNEXPECTED` used to send a reader here and find this silent.
    snapshots: async () =>
      root === undefined
        ? []
        : [...(await unresolvedImportFindings(root)), ...(await checkMigrationSnapshots(root))],
    // `routes: undefined` outside an app is "not judged", which is what the caller already is:
    // `runDoctor` returns on `X_NOT_IN_APP` before this can be asked.
    offlineFallback: async () =>
      root === undefined ? { fallback: null, routes: undefined } : offlineFallbackProbe(root),
    sealedKeys: async () =>
      root === undefined ? { columns: undefined, keys: undefined } : sealedKeysProbe(root),
    authStorage: () => authStorageProbe(process.env['DATABASE_URL'], env),
    pooler: () => poolerProbe(process.env['DATABASE_URL'], env),
    typescript: async () => (root === undefined ? [] : typescriptProbe(root)),
    rowSecurity: async () =>
      root === undefined ? [] : rowSecurityProbe(root, process.env['DATABASE_URL'], env),
  };
}

/** What a load reports, narrowed to the one failure a doctor can name a repair for. */
const unresolvedImportFindings = async (root: string): Promise<readonly Finding[]> =>
  (await loadApp(root)).findings.filter((finding) => finding.code === IMPORT_UNRESOLVED);
