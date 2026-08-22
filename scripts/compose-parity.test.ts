// Single responsibility: every compose file this repo ships — the framework's, both tracked apps'
// and the one `x new` writes — declares the topology `x deploy --method compose` actually runs.
// The plan's roles are derived from `planDeploy`, so a role added to it and to no compose file is a
// deploy that rolls four services and then exits X_DEPLOY_FAILED on `no such service`, which is
// exactly the state both tracked apps were in until 2026-08-22.
//
// Four rules, each recording a defect that shipped: a missing role, a `backfill` with no
// `entrypoint:` (the image's ENTRYPOINT reads ROLE and PORT only, so argv is discarded and the
// service serves HTTP as `web`), a role that starts beside `migrate` instead of after it, and a
// healthcheck invoking `/app/x` — a path only the framework's distroless CLI image carries, so the
// service it guards never becomes healthy and everything gated on it never starts.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { planDeploy, planNewApp } from '@ultimat3/cli';
import { YAML } from 'bun';
import { APP_ROOTS } from './boundaries';

const ROOT = join(import.meta.dir, '..');

/** The one path a compose deploy resolves, in the framework and in an app alike. */
const COMPOSE_FILE = 'docker/docker-compose.prod.yml';

/**
 * `APP_ROOTS` rather than the two directory names: a third tracked app would otherwise ship an
 * unchecked topology, which is the hole this file exists to close for the first two.
 */
const COMPOSE_GLOBS: readonly string[] = [COMPOSE_FILE, `${APP_ROOTS}/*/${COMPOSE_FILE}`];

type Service = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `YAML.parse` answers `unknown`, and a compose file with no `services:` map is its own failure. */
const services = (source: string, at: string): Readonly<Record<string, Service>> => {
  const document = YAML.parse(source);
  const found = isRecord(document) ? document['services'] : undefined;
  expect(isRecord(found), `${at} declares no services map`).toBe(true);
  const table: Record<string, Service> = {};
  for (const [name, service] of Object.entries(isRecord(found) ? found : {})) {
    if (isRecord(service)) table[name] = service;
  }
  return table;
};

/** `environment: { ROLE: web }` and `environment: [ROLE=web]` are the same declaration. */
const roleOf = (service: Service): string | undefined => {
  const environment = service['environment'];
  if (isRecord(environment)) {
    const role = environment['ROLE'];
    return typeof role === 'string' ? role : undefined;
  }
  if (Array.isArray(environment)) {
    for (const entry of environment) {
      if (typeof entry === 'string' && entry.startsWith('ROLE='))
        return entry.slice('ROLE='.length);
    }
  }
  return undefined;
};

/**
 * Every service that runs the app image as a process of the deployment: one carrying a `ROLE`, plus
 * `backfill`, which carries none because it overrides the entrypoint and runs a CLI command
 * (`cmd-deploy.ts` — `ROLES` is a closed list of process shapes and a sweep trigger is a command).
 * `db` and any other infrastructure service carries no ROLE and is none of this rule's business.
 */
const roleServices = (table: Readonly<Record<string, Service>>): readonly string[] =>
  Object.entries(table)
    .filter(([name, service]) => name === 'backfill' || roleOf(service) !== undefined)
    .map(([name]) => name);

/** `depends_on` is a map of conditions or a bare list; only the map can express "has exited 0". */
const waitsForMigrate = (service: Service): boolean => {
  const dependsOn = service['depends_on'];
  if (Array.isArray(dependsOn)) return dependsOn.includes('migrate');
  if (!isRecord(dependsOn)) return false;
  const gate = dependsOn['migrate'];
  return isRecord(gate) && gate['condition'] === 'service_completed_successfully';
};

/** The healthcheck argv, whichever of the two shapes it was written in. */
const healthcheckArgv = (service: Service): readonly string[] => {
  const healthcheck = service['healthcheck'];
  if (!isRecord(healthcheck)) return [];
  const test = healthcheck['test'];
  if (typeof test === 'string') return [test];
  return Array.isArray(test) ? test.filter((word): word is string => typeof word === 'string') : [];
};

/** The roles `x deploy --method compose` rolls, in order, read off the plan rather than restated. */
const DEPLOY_ROLES: readonly string[] = planDeploy('app:probe', 'compose', ROOT).steps.map(
  (step) => step.role,
);

const shipped = COMPOSE_GLOBS.flatMap((glob) => [...new Bun.Glob(glob).scanSync({ cwd: ROOT })]);

/** Read up front: `describe` blocks are registered synchronously and the sources are files. */
const files: { readonly at: string; readonly table: Readonly<Record<string, Service>> }[] = [];
for (const at of shipped.sort()) {
  files.push({ at, table: services(await Bun.file(join(ROOT, at)).text(), at) });
}

// The file `x new` writes, held to the same four rules from the planner rather than from disk — it
// is the reference shape the three above are copies of, and a regression there ships in a tarball.
const scaffolded = planNewApp({ name: 'probe', example: true }).find(
  (file) => file.path === COMPOSE_FILE,
);
// `GeneratedFile.contents` is text OR bytes (an icon is bytes), and a compose file that arrived as
// bytes is a scaffold defect rather than an empty table to check quietly.
const scaffoldedSource = typeof scaffolded?.contents === 'string' ? scaffolded.contents : undefined;
expect(scaffoldedSource, `x new writes no ${COMPOSE_FILE}, or writes it as bytes`).toBeString();
files.push({
  at: `x new → ${COMPOSE_FILE}`,
  table: services(scaffoldedSource ?? '', COMPOSE_FILE),
});

describe('the compose files agree with the deploy plan', () => {
  test('the glob found the framework file, both tracked apps and the scaffold', () => {
    // A glob matching nothing agrees with every rule below it.
    expect(shipped).toContain(COMPOSE_FILE);
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(DEPLOY_ROLES).toContain('backfill');
  });

  for (const { at, table } of files) {
    describe(at, () => {
      test('every role the deploy plan rolls is a service', () => {
        const missing = DEPLOY_ROLES.filter((role) => table[role] === undefined);
        expect(
          missing,
          `${at} has no service for ${missing.join(', ')}, so x deploy exits on "no such service" after the roles before it already rolled`,
        ).toEqual([]);
      });

      test('backfill overrides the entrypoint, or its command is discarded', () => {
        const backfill = table['backfill'];
        if (backfill === undefined) return; // reported by the rule above, not twice here.
        expect(
          Array.isArray(backfill['entrypoint']) || typeof backfill['entrypoint'] === 'string',
          `${at}: backfill declares no entrypoint, so the image's ROLE-only entry discards its command and it serves HTTP as web`,
        ).toBe(true);
      });

      test('every role but migrate waits for migrate to complete', () => {
        const early = roleServices(table).filter(
          (name) => name !== 'migrate' && !waitsForMigrate(table[name] ?? {}),
        );
        expect(
          early,
          `${at}: ${early.join(', ')} start beside migrate, not after it, so a replica can serve against a schema it does not ship`,
        ).toEqual([]);
      });

      test('no healthcheck invokes /app/x — no app image carries it', () => {
        const wrong = Object.entries(table)
          .filter(([, service]) => healthcheckArgv(service).some((word) => word.includes('/app/x')))
          .map(([name]) => name);
        expect(
          wrong,
          `${at}: ${wrong.join(', ')} probe /app/x, which only the framework's CLI image carries — the service never becomes healthy and everything gated on it never starts`,
        ).toEqual([]);
      });
    });
  }
});
