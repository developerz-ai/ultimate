// `x doctor` — everything that makes an environment lie to you, checked in one pass. Every finding
// carries the command that fixes it; a diagnostic that only describes a problem has handed the
// work back to the reader.

import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  ENV_EXAMPLE_PATH,
  ERROR_DOCS_URL,
  tryResolveEnvironment,
  usesDevCursorSecret,
} from '@ultimat3/core';
import {
  checkDb,
  createPostgresClient,
  PGLITE_FIX,
  PGLITE_MISSING,
  PGLITE_PACKAGE,
} from '@ultimat3/db';
import { STORAGE_SIGNING_SECRET_KEY, usesDevStorageSecret } from '@ultimat3/storage';
import { findAppRoot, REQUIRED_BUN, versionAtLeast } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { checkMigrationSnapshots } from './db-snapshot';
import { syncPortFor } from './dev-sync';
import type { OfflineFallbackFact } from './doctor-offline';
import { offlineFallbackFinding, offlineFallbackProbe } from './doctor-offline';
import { intFlagOr, PORT_RANGE, portPairAfter } from './flag-number';
import { ICON_SOURCE } from './icon-assets';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { findingFrom } from './output';
import type { ParsedArgs } from './parse';
import { portFree } from './port-probe';
import { checkMigrationDrift } from './schema-drift';

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
  /** True while cursors are signed with the key shipped in the published package. */
  readonly devCursorSecret: boolean;
  /**
   * True while the local disk WOULD sign upload grants with the key shipped in the published
   * package. Same semantics as `devCursorSecret`, environment only — an app that passes an
   * explicit `signingSecret` in `app.config.ts` never consults the env var, so this can read true
   * for an app that is fine. The finding is worded as a condition to check, not a certainty.
   */
  readonly devStorageSecret: boolean;
  /** True when this process believes it is serving real clients. */
  readonly production: boolean;
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
}

/** What `x doctor` reads about the embedded database, without opening it. */
export interface EmbeddedDatabase {
  /**
   * True while `DATABASE_URL` is unset or blank — the condition that makes PGlite the app's
   * database (`resolveServices`), and the same reading `probeDatabase` returns `null` on.
   */
  readonly selected: boolean;
  /** Does `@electric-sql/pglite` resolve from the app root? */
  readonly resolved: boolean;
}

const finding = (code: string, cause: string, fix: string, at?: string): Finding =>
  at === undefined
    ? { code, cause, fix, docs: ERROR_DOCS_URL }
    : { code, cause, fix, docs: ERROR_DOCS_URL, at };

/**
 * The rule, pure. Red only where the embedded database is the one that would be opened: an app
 * pointed at a real Postgres never loads PGlite, and a finding about an absent optional peer there
 * is noise the reader learns to skim.
 *
 * `@ultimat3/db`'s own refusal, not a CLI twin of it — same `X_DB_UNAVAILABLE`, same sentence,
 * same runnable fix. The package already says this the moment a query arrives; `x doctor` is what
 * says it before `bin/setup` gets that far.
 */
export const embeddedDatabaseFinding = (fact: EmbeddedDatabase): Finding | undefined =>
  fact.selected && !fact.resolved
    ? finding(
        'X_DB_UNAVAILABLE',
        `${PGLITE_MISSING} — and DATABASE_URL is unset, so the embedded one is the database this app would open`,
        PGLITE_FIX,
      )
    : undefined;

/** The file `x doctor` reports missing, and the one the reader creates. */
export const ENV_DEVELOPMENT = '.env.development';

/** The port `x dev` binds by default, so the probe answers about the port the developer will use. */
const DEFAULT_DOCTOR_PORT = 3000;

/**
 * Both ports `x dev` binds, each labelled with the role that wants it. `x dev --port 3999` printed
 * `web listening on 3999`, then died on 4000 as `X_CLI_UNEXPECTED` with a caught `Error` rendered
 * into its cause — and `x doctor --port 3999` answered "no findings", because it probed the web
 * port and only the web port (#F5). The neighbouring port is not an implementation detail an
 * operator can ignore: `docker-compose.prod.yml` publishes `3001:3001` from it and `docker/helm`
 * derives `PORT = .port - 1` from it, so it is part of the contract `x dev` runs by.
 *
 * The suggested port moves BOTH: `x dev --port N` occupies N and N+1, so a free N beside a taken
 * N+1 is still not a runnable command. It did not move both until 2026-09 — the line was
 * `neighbouringPort(probe.port)`, which for the sync finding IS the port the finding is about, and
 * a docblock claiming otherwise is how it survived. `portPairAfter` is the one reader of that rule
 * and `dev-sync.ts`'s own refusal shares it.
 *
 * The sync port is `syncPortFor`, never `neighbouringPort` again: that helper answers 65534 for a
 * web port of 65535 — BELOW the web port, and a port `x dev` never binds — where the boot refuses
 * the run outright with `X_PORT_INVALID`. A probe that reports on a socket the command would never
 * open is answering a question nobody asked, so the boot's own rule decides, and its refusal is
 * reported instead of a probe. Alone, and ahead of the web port: there is no runnable `x dev` at
 * this port whatever the other one answers, and a second finding about it is noise over the cause.
 */
async function portFindings(probe: DoctorProbe): Promise<readonly Finding[]> {
  let syncPort: number;
  try {
    syncPort = syncPortFor(probe.port);
  } catch (error) {
    // The boot's own error, carried whole — `findingFrom` reads its code, cause and fix off the
    // value rather than rendering it, which is what `scripts/catch-render.ts` requires.
    return [findingFrom(error)];
  }
  const wanted = [
    { port: probe.port, role: 'web' },
    { port: syncPort, role: 'sync' },
  ] as const;
  const findings: Finding[] = [];
  for (const entry of wanted) {
    if (await probe.portFree(entry.port)) continue;
    findings.push(
      finding(
        'X_PORT_IN_USE',
        `port ${entry.port} is already listening, and \`x dev --port ${probe.port}\` binds it for the ${entry.role} role`,
        `x dev --port ${portPairAfter(probe.port)}`,
      ),
    );
  }
  return findings;
}

/**
 * Ordered cheapest-first so the first failure is usually the root cause: a wrong Bun explains
 * every other symptom, and running outside an app explains the rest.
 */
export async function runDoctor(probe: DoctorProbe): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  if (!versionAtLeast(probe.bunVersion, REQUIRED_BUN)) {
    findings.push(
      finding(
        'X_BUN_VERSION',
        `Bun ${probe.bunVersion} is older than the required ${REQUIRED_BUN}`,
        'bun upgrade',
      ),
    );
  }
  if (probe.root === undefined) {
    findings.push(
      finding('X_NOT_IN_APP', 'no app.config.ts at or above the working directory', 'x new myapp'),
    );
    return findings;
  }
  if (!probe.exists(ENV_DEVELOPMENT)) {
    findings.push(
      finding(
        'X_ENV_MISSING',
        `${ENV_DEVELOPMENT} is missing, so committed defaults cannot be read`,
        // The file write, named — `X_PWA_ICON_MISSING`'s shape below, and for its reason. This
        // said `x new --force`, which cannot run where the reader is standing: `x new` takes a
        // <name> positional (reproduced: `x new --force --json` inside an app answers
        // `X_CLI_BAD_FLAG`), and with one it scaffolds a SECOND app beside the broken one.
        // `.env.example` is the committed projection of `envSchema`, so the copy lands every
        // declared key with its default and blank secrets; `x env example` writes it where an app
        // has none, and `X_ENV_EXAMPLE_DRIFT` is what reports that.
        `cp ${ENV_EXAMPLE_PATH} ${ENV_DEVELOPMENT}`,
        ENV_DEVELOPMENT,
      ),
    );
  }
  // Production only, and the gate is the point: every development environment signs with the
  // shipped key on purpose — that is what lets `x dev` page with no configuration — so an
  // unconditional finding would make `x doctor` red for every developer on day one and teach the
  // reader to skim past the report. The key is a defect only where cursors reach real clients,
  // who can read it out of the published package and forge a page position.
  // Sits here because it costs two env reads and a comparison — cheaper than binding a port.
  if (probe.production && probe.devCursorSecret) {
    findings.push(
      finding(
        'X_CURSOR_SECRET_DEV',
        'cursors are signed with the shipped development key, so a client can forge a page position',
        'export ULTIMATE_CURSOR_SECRET="$(openssl rand -hex 32)"',
      ),
    );
  }
  // The storage twin of the cursor key above, and the more expensive one to get wrong: the
  // published string mints a signed `PUT` for any key with any `maxBytes` and `contentType`, and
  // `acceptSignedUpload` trusts the signed constraints over the app's own `uploadPolicy`.
  // Production only, for the reason the cursor check gives — every dev environment signs with the
  // shipped key on purpose. `@ultimat3/storage` refuses this at construction; `x doctor` is what
  // reports it before a deploy reaches the refusal.
  if (probe.production && probe.devStorageSecret) {
    findings.push(
      finding(
        'X_STORAGE_SECRET_DEV',
        `${STORAGE_SIGNING_SECRET_KEY} is unset or holds the shipped development key, so a local-disk deploy would accept forged upload grants that override its own uploadPolicy`,
        'export STORAGE_SIGNING_SECRET="$(openssl rand -hex 32)"',
      ),
    );
  }
  findings.push(...(await portFindings(probe)));
  // `@ultimat3/pwa`'s own codes, not CLI twins of them. `X_PWA_NO_ICON_SOURCE` and
  // `X_PWA_NO_FALLBACK` used to be declared here for the same two conditions the package already
  // names — two codes for one condition, one of them registered by nobody, so `x errors explain`
  // answered for the package's and refused the CLI's.
  if (!probe.exists(ICON_SOURCE)) {
    findings.push(
      finding(
        'X_PWA_ICON_MISSING',
        `${ICON_SOURCE} is missing, so install icons and og images cannot be generated`,
        // An edit naming the file, in `@ultimat3/pwa`'s own words (`requireSourceIcon`). Not
        // `x new`: it takes an app name and refuses to run inside the app that is missing the icon,
        // so offering it here hands the reader a command that cannot work where they are standing.
        `add a 1024x1024 square PNG at ${ICON_SOURCE}`,
        ICON_SOURCE,
      ),
    );
  }
  // The DECLARED fallback against the ROUTE TABLE, never a filename: this probed
  // `apps/web/app/offline.tsx`, which is not a route file at all (`assertRouteFilename` refuses
  // it), so no app could clear the finding and its own `fix:` did not either. `doctor-offline.ts`
  // holds the rule and the reasons.
  const offline = offlineFallbackFinding(await probe.offlineFallback());
  if (offline !== undefined) findings.push(offline);
  const database = await probe.database();
  if (database !== null) findings.push(database);
  // The other half of the same question, and the half a bare VM lands on: `database()` is silent
  // where there is no `DATABASE_URL`, and that silence IS the bare-VM configuration.
  const embedded = embeddedDatabaseFinding(await probe.embeddedDatabase());
  if (embedded !== undefined) findings.push(embedded);
  findings.push(...(await probe.drift()));
  // Last, and it is why `X_CLI_UNEXPECTED`'s `fix: x doctor --json` is not a dead end on the path an
  // author reaches it from: `x db gen` throwing `X_MIGRATION_SNAPSHOT_MISSING` used to be a
  // condition this diagnostic could not see at all, so the fix line ran clean over a broken app.
  findings.push(...(await probe.snapshots()));
  return findings;
}

/**
 * The port to TEST, and the one place `x doctor` reads it. `PORT_RANGE.min` is 0 because `x dev
 * --port 0` means "let the kernel pick"; here 0 means nothing, and `Bun.serve({ port: 0 })` always
 * succeeds — so the port check could not fail, which is worse than not running it.
 */
export const doctorPort = (args: ParsedArgs): number =>
  intFlagOr(
    args,
    { name: 'port', command: 'doctor', ...PORT_RANGE, min: 1, example: 'x doctor --port 3000' },
    DEFAULT_DOCTOR_PORT,
  );

/**
 * `DATABASE_URL` as BOTH halves of the database question read it: unset and blank are one case.
 * One seam, because the two halves are complementary — a second reading of the same variable is
 * how a configuration ends up reported by neither probe, or by both.
 */
const externalUrl = (raw: string | undefined): string | undefined =>
  raw === undefined || raw.trim() === '' ? undefined : raw;

/**
 * Is the optional peer INSTALLED for this app — a `node_modules` walk up from the app root.
 *
 * Never an IMPORT: loading PGlite boots 26 MB of WASM and takes the single-writer lock the next
 * command needs, and a diagnostic must not be the reason `x dev` cannot open the database it just
 * reported on.
 *
 * Never `Bun.resolveSync` either, which was this check's first draft. It falls back to Bun's
 * machine-global install cache: measured 2026-09-11 against a freshly scaffolded app with no
 * `node_modules` anywhere above it, `Bun.resolveSync('@electric-sql/pglite', <app>)` answered
 * `~/.bun/install/cache/@electric-sql/pglite@0.5.8@@@1/dist/index.js` — a version the app does not
 * depend on, in a directory `bun install` never wrote for it. A box that had downloaded the package
 * ONCE, for anything, would have read as ready on every app after it, which is the exact opposite
 * of the question. The walk asks what `bun add` answers, and nothing else.
 *
 * Up from the root and not at it, because an app checked out inside a larger workspace is installed
 * by the hoisting one: `examples/dummy` in this repository has no `node_modules` of its own.
 */
const installedAbove = (dir: string, specifier: string): boolean => {
  let current = resolve(dir);
  // Bounded by the path itself — one segment per step — rather than by `for (;;)` and the promise
  // that `dirname('/')` is `/`. The loop still stops on that, one step earlier.
  for (let remaining = current.split(sep).length; remaining > 0; remaining -= 1) {
    if (existsSync(join(current, 'node_modules', specifier, 'package.json'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
};

/**
 * A real `select 1` through the app's own driver, not a TCP connect: a running Postgres with the
 * wrong credentials or a database that does not exist accepts the socket and refuses the session,
 * which is the case an operator most needs told about before a deploy.
 *
 * The pool is CLOSED on every path — this command exits, and a held pool is a connection slot the
 * next `x db migrate` cannot have.
 */
async function probeDatabase(url: string | undefined): Promise<Finding | null> {
  if (externalUrl(url) === undefined) return null;
  const client = createPostgresClient({ url, applicationName: 'x-doctor' });
  try {
    const report = await checkDb(client);
    if (report.ok) return null;
    // `DbHealthReport.error` is `checkDb`'s own rendering of what refused, never this file's — the
    // caught value is `checkDb`'s to read, and it is the one function that already reads it safely.
    return finding(
      'X_DB_UNAVAILABLE',
      `DATABASE_URL does not answer \`select 1\`: ${report.error ?? 'no reason reported'}`,
      // `dbUnavailable`'s own two branches, verbatim: a second wording for one condition is two
      // answers to "what do I do", and this one is reached first, before any command opens a pool.
      'set DATABASE_URL to a reachable Postgres url, or run `x dev` to use the embedded PGlite',
    );
  } finally {
    await client.close();
  }
}

export function probeFor(cwd: string, bunVersion: string, port: number): DoctorProbe {
  const root = findAppRoot(cwd)?.dir;
  return {
    bunVersion,
    root,
    port,
    devCursorSecret: usesDevCursorSecret(),
    devStorageSecret: usesDevStorageSecret(),
    // `ULTIMATE_ENV`, through core — the one key that says which deploy this is, with `NODE_ENV`
    // as its documented fallback. This read `X_ENV ?? NODE_ENV`, a spelling nothing else in the
    // repo reads, so a deploy declaring production the framework's own way was told it was not
    // production and skipped both secret findings; and the `??` short-circuited, so any non-empty
    // `X_ENV` shadowed a real `NODE_ENV=production` too. The non-throwing variant because
    // `ULTIMATE_ENV` is not in the env schema — nothing validates it at boot, and a diagnostic
    // that crashes on a typo is the one thing worse than a diagnostic that misses.
    production: tryResolveEnvironment() === 'production',
    exists: (relativePath) => (root === undefined ? false : existsSync(join(root, relativePath))),
    portFree,
    database: () => probeDatabase(process.env['DATABASE_URL']),
    // `root ?? cwd` because the walk needs a directory that exists; outside an app `runDoctor`
    // returns on `X_NOT_IN_APP` before this is ever asked, so the value only has to be honest.
    embeddedDatabase: async () => ({
      selected: externalUrl(process.env['DATABASE_URL']) === undefined,
      resolved: installedAbove(root ?? cwd, PGLITE_PACKAGE),
    }),
    drift: async () => (root === undefined ? [] : checkMigrationDrift(root)),
    snapshots: async () => (root === undefined ? [] : checkMigrationSnapshots(root)),
    // `routes: undefined` outside an app is "not judged", which is what the caller already is:
    // `runDoctor` returns on `X_NOT_IN_APP` before this can be asked.
    offlineFallback: async () =>
      root === undefined ? { fallback: null, routes: undefined } : offlineFallbackProbe(root),
  };
}

export const doctorCommand: CliCommand = {
  spec: {
    name: 'doctor',
    summary: 'environment, versions, drift, ports, PWA prerequisites — each with a fix command',
    usage: 'x doctor [--port 3000] [--json]',
    flags: [
      {
        name: 'port',
        type: 'string',
        summary: 'port to test',
        default: String(DEFAULT_DOCTOR_PORT),
      },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const port = doctorPort(ctx.args);
    const findings = await runDoctor(probeFor(ctx.cwd, ctx.bunVersion, port));
    return {
      ok: findings.length === 0,
      command: 'doctor',
      summary:
        findings.length === 0
          ? msg('cli.doctor.clean')
          : msg('cli.doctor.findings', { count: findings.length }),
      findings,
      data: { count: findings.length, codes: findings.map((entry) => entry.code) },
    };
  },
};
