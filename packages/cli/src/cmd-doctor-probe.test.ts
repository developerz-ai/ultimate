// `x doctor`'s probe and command: what `probeFor` reads off the real machine, the command's own
// wiring, and the whole surface `x dev` binds. The findings over a fixed probe are `cmd-doctor.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove, and Bun.write is async in these synchronous
// fixture helpers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { PGLITE_FIX, PGLITE_MISSING } from '@ultimat3/db';
import { REQUIRED_BUN } from './app-root';
import { doctorCommand, probeFor, runDoctor } from './cmd-doctor';
import { codes, probe } from './cmd-doctor-fixture';
import type { CommandContext } from './command';
import type { Finding } from './output';
import { parseArgs } from './parse';

describe('unit · x doctor · probeFor', () => {
  type EnvKey = 'ULTIMATE_ENV' | 'X_ENV' | 'NODE_ENV';
  const KEYS: readonly EnvKey[] = ['ULTIMATE_ENV', 'X_ENV', 'NODE_ENV'];
  const SAVED = new Map(KEYS.map((key) => [key, Bun.env[key]]));

  const setEnv = (key: EnvKey, value: string | undefined): void => {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  };

  afterEach(() => {
    for (const key of KEYS) setEnv(key, SAVED.get(key));
  });

  // The framework-secret codes the probe reports, asked with no secret set, so a code is exactly
  // "this machine names a deployed environment and lacks the key". Read through the ambient
  // environment, as a bare `x doctor` reads it.
  const owed = (over: Partial<Record<EnvKey, string>>): readonly string[] => {
    for (const key of KEYS) setEnv(key, over[key]);
    const env = {
      ...Bun.env,
      ULTIMATE_CURSOR_SECRET: '',
      STORAGE_SIGNING_SECRET: '',
      S3_ENDPOINT: '',
    };
    return probeFor(import.meta.dir, '1.3.14', 3000, env).frameworkFindings.map((f) => f.code);
  };
  const production = (over: Partial<Record<EnvKey, string>>): boolean => owed(over).length > 0;

  test('ULTIMATE_ENV=production is a production process', () => {
    expect(production({ ULTIMATE_ENV: 'production' })).toBe(true);
  });

  // Core's documented fallback, kept: every container image and platform sets it, and an app that
  // never heard of `ULTIMATE_ENV` must still be diagnosed correctly.
  test('NODE_ENV=production alone is a production process', () => {
    expect(production({ NODE_ENV: 'production' })).toBe(true);
  });

  // The precedence that matters: a base image that bakes in `NODE_ENV=production` would otherwise
  // make `x doctor` report a forgeable cursor at every `x dev` inside it, and the developer who
  // said so with the framework's own key would have been overruled by the image.
  test('ULTIMATE_ENV overrides NODE_ENV rather than falling back to it', () => {
    expect(production({ ULTIMATE_ENV: 'development', NODE_ENV: 'production' })).toBe(false);
  });

  // `X_ENV` is a spelling nothing in this repo reads. It must not decide, and — this is the half
  // that bit — it must not SHADOW: `X_ENV ?? NODE_ENV` short-circuited on any non-empty value, so
  // one stale variable turned a real production deploy into "not production".
  test('X_ENV decides nothing, and shadows nothing', () => {
    expect(production({ X_ENV: 'production', ULTIMATE_ENV: 'development' })).toBe(false);
    expect(production({ X_ENV: 'production' })).toBe(false);
    expect(production({ X_ENV: 'prod', NODE_ENV: 'production' })).toBe(true);
  });

  // `ULTIMATE_ENV` is not in the env schema, so nothing validates it at boot and `x doctor` can be
  // its first reader. `tryResolveEnvironment` answers `undefined` rather than throwing — a typo
  // must be a diagnostic that runs, not a diagnostic that crashes.
  test('a misspelled ULTIMATE_ENV answers "not production" instead of throwing', () => {
    expect(production({ ULTIMATE_ENV: 'prodcution' })).toBe(false);
  });

  // Doctor answers about THIS machine, so it reports only an environment the machine NAMES as
  // deployed. A developer shell naming none is not a deploy — `x env check` is the command that
  // answers "what would a deployed boot do with this table" (fail closed), and it does (#679).
  test('an unnamed environment owes nothing here: a developer shell is not a deploy', () => {
    expect(owed({})).toEqual([]);
  });

  // Staging is refused at boot too; asking `=== 'production'` let doctor stay silent about it.
  test('ULTIMATE_ENV=staging owes both, as production does', () => {
    expect(owed({ ULTIMATE_ENV: 'staging' })).toEqual([
      'X_CURSOR_SECRET_DEV',
      'X_STORAGE_SECRET_DEV',
    ]);
    expect(owed({ ULTIMATE_ENV: 'production' })).toEqual([
      'X_CURSOR_SECRET_DEV',
      'X_STORAGE_SECRET_DEV',
    ]);
    expect(owed({ NODE_ENV: 'staging' })).toEqual(['X_CURSOR_SECRET_DEV', 'X_STORAGE_SECRET_DEV']);
  });

  // #679: object storage never builds the embedded disk, so its signing key is never read — and a
  // finding that fires anyway is one the reader of an S3 deploy learns to skip.
  test('the storage secret is owed only where the embedded disk would be built', () => {
    const owes = (env: Record<string, string>) =>
      probeFor(import.meta.dir, '1.3.14', 3000, { ULTIMATE_ENV: 'production', ...env })
        .frameworkFindings.map((finding) => finding.code)
        .includes('X_STORAGE_SECRET_DEV');
    expect(owes({})).toBe(true);
    expect(owes({ S3_ENDPOINT: 'https://s3.example.com', S3_BUCKET: 'uploads' })).toBe(false);
    expect(owes({ STORAGE_SIGNING_SECRET: 's'.repeat(64) })).toBe(false);
  });
});

// `probeFor` is where `x doctor`'s diagnosis meets the machine. Only the deterministic half is
// asserted: a port THIS test holds is not free, and the readers that depend on an app root answer
// nothing when there is none. Whether an arbitrary port is free is not a fact a test can own.
describe('unit · x doctor · probeFor reaches the real machine', () => {
  test('a port this process is holding is reported as not free', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('') });
    try {
      // `Server.port` is `number | undefined` — a unix-socket server has none. `port: 0` always
      // opens a TCP one, so an absent port is a broken assumption, never a case to default.
      const taken = server.port ?? expect.unreachable('Bun.serve({ port: 0 }) opened no TCP port');
      expect(await probeFor(import.meta.dir, '1.3.14', taken).portFree(taken)).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test('outside an app, the root-dependent readers answer empty rather than throwing', async () => {
    // `/` has no app.config.ts at or above it, so `findAppRoot` answers undefined.
    const outside = probeFor('/', '1.3.14', 3000);
    expect(outside.root).toBeUndefined();
    expect(outside.exists('apps/web/site/page.tsx')).toBe(false);
    expect(await outside.drift()).toEqual([]);
    expect(await outside.snapshots()).toEqual([]);
  });

  test('inside an app, exists() is resolved against the app root and not against the cwd', () => {
    const root = doctorAppRoot();
    try {
      // Called from a SUBDIRECTORY, so a reader that resolved against the cwd would miss both.
      const inside = probeFor(join(root, 'apps', 'web'), '1.3.14', 3000);
      expect(inside.root).toBe(root);
      expect(inside.exists('app.config.ts')).toBe(true);
      expect(inside.exists('this-file-does-not-exist.txt')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('unit · x doctor · the command', () => {
  const doctorContext = (argv: readonly string[], cwd: string): CommandContext => ({
    args: parseArgs(argv, [doctorCommand.spec]),
    cwd,
    // `x doctor` diagnoses in-process; a subprocess from it is the bug, not a fixture.
    runner: (command) => {
      throw new Error(`x doctor spawned ${command.join(' ')}`);
    },
    env: {},
    bunVersion: REQUIRED_BUN,
  });

  test('a port that is taken is reported as X_PORT_IN_USE, and --json lists the codes', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('') });
    const root = doctorAppRoot();
    try {
      const result = await doctorCommand.run(
        doctorContext(['doctor', '--port', String(server.port), '--json'], root),
      );
      expect(result.ok).toBe(false);
      expect(result.command).toBe('doctor');
      const data = result.data as { count: number; codes: readonly string[] };
      expect(data.codes).toContain('X_PORT_IN_USE');
      expect(data.count).toBe((result.findings ?? []).length);
      // Every finding the report counted is a finding the report carries.
      expect(data.codes).toEqual((result.findings ?? []).map((finding) => finding.code));
    } finally {
      await server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** The smallest thing `findAppRoot` accepts, plus one subdirectory to be called from. */
function doctorAppRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'x-doctor-'));
  mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
  writeFileSync(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  return dir;
}

describe('unit · x doctor probes the whole surface x dev binds', () => {
  // `x dev --port 3999` printed `web listening on 3999`, then died on 4000 as X_CLI_UNEXPECTED
  // with a caught `Error` rendered into its cause — and `x doctor --port 3999` answered
  // "no findings — environment is shippable", because it probed one port of the two (#F5).
  test('the sync port is probed too, and the finding names the role that wants it', async () => {
    const findings = await runDoctor(
      probe({ port: 3999, portFree: async (port) => port !== 4000 }),
    );
    expect(findings.map((entry) => entry.code)).toEqual(['X_PORT_IN_USE']);
    expect(findings[0]?.cause).toContain('port 4000');
    expect(findings[0]?.cause).toContain('sync');
  });

  test('a taken web port still names the web role, so the two are never confused', async () => {
    const findings = await runDoctor(
      probe({ port: 3999, portFree: async (port) => port !== 3999 }),
    );
    expect(findings[0]?.cause).toContain('port 3999');
    expect(findings[0]?.cause).toContain('web');
  });

  // `x doctor` answered "shippable" against DATABASE_URL=postgres://nope:nope@localhost:5432/nope
  // while `x db migrate` on the same env answered X_DB_UNAVAILABLE.
  test('an unreachable database is a finding with the same fix @ultimat3/db gives', async () => {
    const unreachable: Finding = {
      code: 'X_DB_UNAVAILABLE',
      cause: 'DATABASE_URL does not answer `select 1`: connection refused',
      fix: 'set DATABASE_URL to a reachable Postgres url, or run `x dev` to use the embedded PGlite',
    };
    const codesFound = await codes(probe({ database: async () => unreachable }));
    expect(codesFound).toContain('X_DB_UNAVAILABLE');
  });

  test('an embedded database is not probed at all — that lock belongs to x dev', async () => {
    expect(await codes(probe())).toEqual([]);
  });

  // The bare-VM hole, and the reason it stayed open: `database()` answers `null` with no
  // DATABASE_URL, so the one configuration a dz-runner box actually has was the one configuration
  // `x doctor` said nothing about. `bin/setup` reported it instead, four commands later, as an
  // `x db migrate` failure.
  test('a bare VM whose optional peer never installed is red, in @ultimat3/db own words', async () => {
    const findings = await runDoctor(
      probe({ embeddedDatabase: async () => ({ selected: true, resolved: false }) }),
    );
    expect(findings.map((entry) => entry.code)).toEqual(['X_DB_UNAVAILABLE']);
    expect(findings[0]?.cause).toContain(PGLITE_MISSING);
    expect(findings[0]?.cause).toContain('DATABASE_URL is unset');
    // Runnable, and the package's own line — not a second wording for one condition.
    expect(findings[0]?.fix).toBe(PGLITE_FIX);
  });

  // An app pointed at a real Postgres never loads PGlite, so an absent optional peer there is not
  // a defect. `database()` owns that configuration, and a second finding about it is noise.
  test('an app with a DATABASE_URL is not asked to install the embedded database', async () => {
    expect(
      await codes(probe({ embeddedDatabase: async () => ({ selected: false, resolved: false }) })),
    ).toEqual([]);
  });
});
