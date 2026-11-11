// The real-machine probe for `x doctor`. It reads app, database and filesystem facts without deciding
// their diagnostics, keeping injected environments aligned with the command's parsed port settings.

// why: Bun has no synchronous file-exists or path-join API; the probe answers `exists` synchronously.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PGLITE_PACKAGE } from '@ultimat3/db';
import { loadApp } from './app-load';
import { IMPORT_UNRESOLVED } from './app-load-unresolved';
import { findAppRoot } from './app-root';
import { checkMigrationSnapshots } from './db-snapshot';
import { authStorageProbe } from './doctor-auth';
import { externalUrl, installedAbove, probeDatabase } from './doctor-database';
import { offlineFallbackProbe } from './doctor-offline';
import { poolerProbe } from './doctor-pooler';
import type { DoctorProbe } from './doctor-probe-types';
import { rowSecurityProbe } from './doctor-row-security';
import { sealedKeysProbe } from './doctor-sealed';
import { typescriptProbe } from './doctor-typescript';
import { machineSecretFindings } from './framework-env';
import type { Finding } from './output';
import { portFree } from './port-probe';
import { checkMigrationDrift } from './schema-drift';

/** Builds the real probe, resolving app-relative facts from the discovered root. */
export function probeFor(
  cwd: string,
  bunVersion: string,
  port: number,
  // The environment `doctorPort` read `PORT` from, shared by every environment-dependent fact.
  env: Readonly<Record<string, string | undefined>> = process.env,
): DoctorProbe {
  const root = findAppRoot(cwd)?.dir;
  return {
    bunVersion,
    root,
    port,
    appUrl: env['APP_URL'],
    frameworkFindings: machineSecretFindings(env),
    exists: (relativePath) => root !== undefined && existsSync(join(root, relativePath)),
    portFree,
    database: () => probeDatabase(env['DATABASE_URL'], env),
    // Outside an app `runDoctor` returns before asking; the walk still needs an existing directory.
    embeddedDatabase: async () => ({
      selected: externalUrl(env['DATABASE_URL']) === undefined,
      resolved: installedAbove(root ?? cwd, PGLITE_PACKAGE),
    }),
    drift: async () => (root === undefined ? [] : checkMigrationDrift(root)),
    // The import half too: `X_CLI_UNEXPECTED` used to send a reader here and find this silent.
    snapshots: async () =>
      root === undefined
        ? []
        : [...(await unresolvedImportFindings(root)), ...(await checkMigrationSnapshots(root))],
    // `routes: undefined` outside an app is "not judged", matching the sequencer's early return.
    offlineFallback: async () =>
      root === undefined ? { fallback: null, routes: undefined } : offlineFallbackProbe(root),
    sealedKeys: async () =>
      root === undefined ? { columns: undefined, keys: undefined } : sealedKeysProbe(root),
    authStorage: () => authStorageProbe(env['DATABASE_URL'], env),
    pooler: () => poolerProbe(env['DATABASE_URL'], env),
    typescript: async () => (root === undefined ? [] : typescriptProbe(root)),
    rowSecurity: async () =>
      root === undefined ? [] : rowSecurityProbe(root, env['DATABASE_URL'], env),
  };
}

/** What a load reports, narrowed to the one failure a doctor can name a repair for. */
const unresolvedImportFindings = async (root: string): Promise<readonly Finding[]> =>
  (await loadApp(root)).findings.filter((finding) => finding.code === IMPORT_UNRESOLVED);
