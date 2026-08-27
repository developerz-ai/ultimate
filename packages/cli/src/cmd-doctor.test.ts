import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove, and Bun.write is async in these synchronous
// fixture helpers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import type { DoctorProbe } from './cmd-doctor';
import { doctorCommand, doctorPort, OFFLINE_FALLBACK, probeFor, runDoctor } from './cmd-doctor';
import type { CommandContext } from './command';
import { PORT_RANGE, parseIntFlag } from './flag-number';
import { ICON_SOURCE } from './icon-assets';
import type { Finding } from './output';
import type { ParsedArgs } from './parse';
import { parseArgs } from './parse';

const probe = (over: Partial<DoctorProbe> = {}): DoctorProbe => ({
  bunVersion: REQUIRED_BUN,
  root: '/app',
  port: 3000,
  // The ordinary developer: the shipped cursor key, off production. Every case below that does
  // not say otherwise is this one.
  devCursorSecret: true,
  devStorageSecret: true,
  production: false,
  exists: () => true,
  portFree: async () => true,
  // Reachable, or embedded — the probe's own `null`. A test that opened a pool would be asking
  // about the box it runs on rather than about `runDoctor`.
  database: async () => null,
  drift: async () => [],
  snapshots: async () => [],
  ...over,
});

const codes = async (input: DoctorProbe): Promise<readonly string[]> =>
  (await runDoctor(input)).map((finding) => finding.code);

describe('unit · x doctor', () => {
  test('a healthy environment reports nothing', async () => {
    expect(await codes(probe())).toEqual([]);
  });

  test('a missing offline fallback is reported with the generator that creates it', async () => {
    const findings = await runDoctor(probe({ exists: (path) => path !== OFFLINE_FALLBACK }));
    const fallback = findings.find((finding) => finding.code === 'X_PWA_NO_OFFLINE_FALLBACK');
    expect(fallback?.cause).toContain(OFFLINE_FALLBACK);
    expect(fallback?.fix).toBe('x g route offline --surface app');
    expect(fallback?.at).toBe(OFFLINE_FALLBACK);
  });

  test('a missing source icon is reported separately from the fallback', async () => {
    const findings = await runDoctor(probe({ exists: (path) => path !== ICON_SOURCE }));
    expect(findings.map((finding) => finding.code)).toEqual(['X_PWA_ICON_MISSING']);
    // An edit naming the file, pinned verbatim. `x new` was here and could never run: it takes an
    // app name, so it is not an instruction anyone inside the broken app can follow.
    expect(findings[0]?.fix).toBe(`add a 1024x1024 square PNG at ${ICON_SOURCE}`);
    expect(findings[0]?.fix).not.toContain('x new');
  });

  test('an occupied port suggests the next one', async () => {
    const findings = await runDoctor(probe({ portFree: async () => false }));
    expect(findings[0]?.code).toBe('X_PORT_IN_USE');
    expect(findings[0]?.fix).toBe('x dev --port 3001');
  });

  // The bug this guards: `port + 1` at the top of the range emitted `x dev --port 65536`, which
  // `x dev` refuses with X_CLI_BAD_FLAG — a fix line that reproduces a failure instead of ending
  // one. The neighbour below is a port; the one above does not exist.
  test('the suggested port is one x dev accepts, at the top of the range too', async () => {
    const top = await runDoctor(probe({ port: PORT_RANGE.max, portFree: async () => false }));
    expect(top[0]?.fix).toBe(`x dev --port ${PORT_RANGE.max - 1}`);
    // And the suggestion is still parseable by the reader it is handed to.
    for (const port of [3000, PORT_RANGE.max]) {
      const findings = await runDoctor(probe({ port, portFree: async () => false }));
      const suggested = Number((findings[0]?.fix ?? '').split(' ').at(-1));
      // `x dev`'s own flag config, so the assertion is that the READER of this line accepts it.
      expect(
        parseIntFlag(String(suggested), {
          name: 'port',
          command: 'dev',
          ...PORT_RANGE,
          example: 'x dev --port 3000',
        }),
      ).toBe(suggested);
    }
  });

  // `Bun.serve({ port: 0 })` always succeeds, so `x doctor --port 0` ran a check that could not
  // fail. 0 means "let the kernel pick" to `x dev` and means nothing at all to a probe.
  test('--port 0 is refused: a port to TEST is never the kernel picking one', () => {
    const args = (value: string): ParsedArgs =>
      parseArgs(['doctor', '--port', value], [doctorCommand.spec]);
    let caught: unknown;
    try {
      doctorPort(args('0'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'X_CLI_BAD_FLAG' });
    expect(doctorPort(args('1'))).toBe(1);
    expect(doctorPort(args(String(PORT_RANGE.max)))).toBe(PORT_RANGE.max);
  });

  test('running outside an app stops after the one finding that explains everything', async () => {
    const findings = await runDoctor(probe({ root: undefined, exists: () => false }));
    expect(findings.map((finding) => finding.code)).toEqual(['X_NOT_IN_APP']);
    expect(findings[0]?.fix).toBe('x new myapp');
  });

  test('an old Bun is reported first, because it explains the rest', async () => {
    const findings = await runDoctor(probe({ bunVersion: '1.2.0' }));
    expect(findings[0]?.code).toBe('X_BUN_VERSION');
    expect(findings[0]?.fix).toBe('bun upgrade');
  });

  test('drift findings are appended with their own fix command', async () => {
    const findings = await runDoctor(
      probe({
        drift: async () => [
          { code: 'X_DB_DRIFT', cause: 'schema differs', fix: 'x db gen "add publish_at"' },
        ],
      }),
    );
    expect(findings.at(-1)?.fix).toBe('x db gen "add publish_at"');
  });

  // `X_CLI_UNEXPECTED`'s own `fix:` is `x doctor --json`, and the throw an author most often hits
  // on a first run is `x db gen` refusing a migration with no snapshot — a condition this probe
  // could not see, so the fix ran clean and reported nothing about the thing that was broken.
  test('a migration with no snapshot sidecar is reported, so the X_CLI_UNEXPECTED fix answers', async () => {
    const findings = await runDoctor(
      probe({
        snapshots: async () => [
          {
            code: 'X_MIGRATION_SNAPSHOT_MISSING',
            cause: 'migration "0001_init" records no schema snapshot',
            fix: 'git checkout -- packages/db/migrations/0001_init.snapshot.json',
          },
        ],
      }),
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_MIGRATION_SNAPSHOT_MISSING']);
  });

  // A finding every developer sees on day one is one they learn to skip, and the report goes with
  // it — so the noise case is what makes the production gate real, not the finding itself.
  test('the shipped cursor key is silent in development, where it is the design', async () => {
    expect(await codes(probe({ devCursorSecret: true }))).toEqual([]);
  });

  test('the shipped cursor key in production is reported with the command that mints one', async () => {
    const findings = await runDoctor(probe({ devCursorSecret: true, production: true }));
    const cursor = findings.find((finding) => finding.code === 'X_CURSOR_SECRET_DEV');
    expect(cursor?.cause).toContain('forge a page position');
    // Pinned verbatim: this string is copied into a shell, so a paraphrase of it is a broken fix.
    expect(cursor?.fix).toBe('export ULTIMATE_CURSOR_SECRET="$(openssl rand -hex 32)"');
  });

  test('a production deploy with its own secrets reports nothing', async () => {
    expect(
      await codes(probe({ devCursorSecret: false, devStorageSecret: false, production: true })),
    ).toEqual([]);
  });

  // The storage twin, and the more expensive one: the published key mints a signed PUT for any
  // key with any maxBytes and contentType, and `acceptSignedUpload` trusts a signed constraint
  // over the app's own uploadPolicy.
  test('the shipped storage key is silent in development, where it is the design', async () => {
    expect(await codes(probe({ devStorageSecret: true }))).toEqual([]);
  });

  test('the shipped storage key in production is reported with the command that mints one', async () => {
    const findings = await runDoctor(
      probe({ devCursorSecret: false, devStorageSecret: true, production: true }),
    );
    const storage = findings.find((finding) => finding.code === 'X_STORAGE_SECRET_DEV');
    expect(storage?.cause).toContain('STORAGE_SIGNING_SECRET');
    expect(storage?.cause).toContain('uploadPolicy');
    // Pinned verbatim: this string is copied into a shell, so a paraphrase of it is a broken fix.
    expect(storage?.fix).toBe('export STORAGE_SIGNING_SECRET="$(openssl rand -hex 32)"');
  });

  test('every finding carries a fix command — a diagnostic without one is not shippable', async () => {
    const findings = await runDoctor(probe({ exists: () => false, portFree: async () => false }));
    expect(findings.length).toBeGreaterThan(2);
    for (const finding of findings) expect(finding.fix.length).toBeGreaterThan(0);
  });
});

// Every case above hands `runDoctor` the `production` boolean, so the one place that derives it
// from the environment is the half nothing covered — and it decides whether BOTH secret findings
// fire at all. It read `X_ENV ?? NODE_ENV`, a spelling nothing else in the repo reads, so a deploy
// that declared production the framework's own documented way (`ULTIMATE_ENV=production`) was told
// it was not production and skipped the two checks standing between it and a published signing
// key. All three variables are restored after each case: bun shares one process across test files,
// and a leaked environment would decide a later file's answer by load order.
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

  const production = (over: Partial<Record<EnvKey, string>>): boolean => {
    for (const key of KEYS) setEnv(key, over[key]);
    return probeFor(import.meta.dir, '1.3.14', 3000).production;
  };

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
    expect(production({ X_ENV: 'production' })).toBe(false);
    expect(production({ X_ENV: 'prod', NODE_ENV: 'production' })).toBe(true);
  });

  // `ULTIMATE_ENV` is not in the env schema, so nothing validates it at boot and `x doctor` can be
  // its first reader. `tryResolveEnvironment` answers `undefined` rather than throwing — a typo
  // must be a diagnostic that runs, not a diagnostic that crashes.
  test('a misspelled ULTIMATE_ENV answers "not production" instead of throwing', () => {
    expect(production({ ULTIMATE_ENV: 'prodcution' })).toBe(false);
  });

  test('no variable set is not production', () => {
    expect(production({})).toBe(false);
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
  writeFileSync(join(dir, 'app.config.ts'), 'export const config = {};\n');
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
});
