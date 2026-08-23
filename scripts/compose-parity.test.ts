// Single responsibility: every compose file this repo ships — the framework's, both tracked apps'
// and the one `x new` writes — declares the topology `x deploy --method compose` actually runs.
// The plan's roles are derived from `planDeploy`, so a role added to it and to no compose file is a
// deploy that rolls four services and then exits X_DEPLOY_FAILED on `no such service`, which is
// exactly the state both tracked apps were in until 2026-08-22.
//
// Five rules, each recording a defect that shipped: a missing role, a `backfill` with no
// `entrypoint:` (the image's ENTRYPOINT reads ROLE and PORT only, so argv is discarded and the
// service serves HTTP as `web`), a role that starts beside `migrate` instead of after it, a
// healthcheck invoking `/app/x` — a path only the framework's distroless CLI image carries, so the
// service it guards never becomes healthy and everything gated on it never starts — and a role that
// INHERITS the image's `/readyz` probe while opening no HTTP socket, which is the same ending
// reached from the other direction: `unhealthy` forever, on a port the role never binds.
//
// A sixth rule covers the OTHER compose file, `docker-compose.dev.yml`: every published port binds
// a loopback address. A dev stack ships its credentials in the file, so Docker's short form
// `'5432:5432'` — which binds 0.0.0.0 and writes DNAT rules a host firewall does not stop — hands
// an authenticated Postgres to everyone on the café wifi.

import { describe, expect, test } from 'bun:test';
// `join` builds the host-separator paths to ROOT and each compose file; Bun ships no path join.
import { join } from 'node:path';
import { planDeploy, planNewApp } from '@ultimat3/cli';
import { YAML } from 'bun';
import { APP_ROOTS } from './boundaries';

const ROOT = join(import.meta.dir, '..');

/** The one path a compose deploy resolves, in the framework and in an app alike. */
const COMPOSE_FILE = 'docker/docker-compose.prod.yml';

/** Its development counterpart — never deployed, always credentialled, and so the loopback rule. */
const DEV_COMPOSE_FILE = 'docker/docker-compose.dev.yml';

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

/**
 * `depends_on` is a map of conditions or a bare list, and only the map can express "has exited 0".
 * The LIST FORM IS REFUSED for that reason: `depends_on: [migrate]` is `service_started`, which
 * `docker compose up -d` satisfies the moment the migrator's container exists — so the role it
 * guards can serve against a schema whose migration is still running, which is the whole defect
 * this rule exists to catch. Accepting it here would have passed exactly that file.
 */
const waitsForMigrate = (service: Service): boolean => {
  const dependsOn = service['depends_on'];
  if (!isRecord(dependsOn)) return false;
  const gate = dependsOn['migrate'];
  return isRecord(gate) && gate['condition'] === 'service_completed_successfully';
};

/**
 * The two roles that construct an HTTP server (`startRoles`, packages/cli/src/dev-roles.ts). Every
 * other role gets the metrics listener and nothing else, so the image's `/readyz` HEALTHCHECK is a
 * fetch to a port it never binds. `backfill` carries no ROLE and is one of them — it overrides the
 * entrypoint and exits.
 */
const HTTP_ROLES: readonly string[] = ['web', 'sync'];

/** The healthcheck argv, whichever of the two shapes it was written in. */
const healthcheckArgv = (service: Service): readonly string[] => {
  const healthcheck = service['healthcheck'];
  if (!isRecord(healthcheck)) return [];
  const test = healthcheck['test'];
  if (typeof test === 'string') return [test];
  return Array.isArray(test) ? test.filter((word): word is string => typeof word === 'string') : [];
};

/**
 * A service that declares its own probe, in either legal shape: `disable: true` for a run-once
 * container, or a `test:` naming something other than the endpoint it does not serve. Inheriting
 * the image's is what this answers `false` for.
 */
const overridesImageProbe = (service: Service): boolean => {
  const healthcheck = service['healthcheck'];
  if (!isRecord(healthcheck)) return false;
  if (healthcheck['disable'] === true) return true;
  const argv = healthcheckArgv(service);
  return argv.length > 0 && !argv.some((word) => word.includes('/readyz'));
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

/** One `x new`, read twice: the planner is deterministic and the prod and dev files both come off it. */
const SCAFFOLD = planNewApp({ name: 'probe', example: true });

/**
 * The compose file `x new` writes, held to the same rules from the planner rather than from disk —
 * it is the reference shape the tracked apps' copies come from, and a regression there ships in a
 * tarball. `GeneratedFile.contents` is text OR bytes (an icon is bytes), and a compose file that
 * arrived as bytes is a scaffold defect rather than an empty table to check quietly.
 */
const scaffoldedCompose = (path: string): string => {
  const contents = SCAFFOLD.find((file) => file.path === path)?.contents;
  const source = typeof contents === 'string' ? contents : undefined;
  expect(source, `x new writes no ${path}, or writes it as bytes`).toBeString();
  return source ?? '';
};

files.push({
  at: `x new → ${COMPOSE_FILE}`,
  table: services(scaffoldedCompose(COMPOSE_FILE), COMPOSE_FILE),
});

/** The dev stacks, on the same glob: the framework's, both tracked apps' and the scaffold's. */
const shippedDev = [DEV_COMPOSE_FILE, `${APP_ROOTS}/*/${DEV_COMPOSE_FILE}`].flatMap((glob) => [
  ...new Bun.Glob(glob).scanSync({ cwd: ROOT }),
]);

const devFiles: { readonly at: string; readonly table: Readonly<Record<string, Service>> }[] = [];
for (const at of shippedDev.sort()) {
  devFiles.push({ at, table: services(await Bun.file(join(ROOT, at)).text(), at) });
}
devFiles.push({
  at: `x new → ${DEV_COMPOSE_FILE}`,
  table: services(scaffoldedCompose(DEV_COMPOSE_FILE), DEV_COMPOSE_FILE),
});

/**
 * The host interface a published port binds, or `undefined` for the short form — which is Docker's
 * way of writing `0.0.0.0`. Three shapes are legal: `'5432:5432'`, `'127.0.0.1:5432:5432'` and the
 * long form `{ host_ip, published, target }`. IPv6 arrives bracketed (`'[::1]:5432:5432'`), so the
 * host cannot be taken as the first colon-separated field.
 */
const hostIpOf = (entry: unknown): string | undefined => {
  if (isRecord(entry)) {
    const hostIp = entry['host_ip'];
    return typeof hostIp === 'string' && hostIp !== '' ? hostIp : undefined;
  }
  if (typeof entry !== 'string') return undefined; // `ports: [5432]` — a bare number, so 0.0.0.0.
  if (entry.startsWith('[')) return entry.slice(1, entry.indexOf(']'));
  const fields = entry.split(':');
  // `<host>:<published>:<target>` is the only form carrying a host; two fields is host:container.
  return fields.length >= 3 ? fields.slice(0, -2).join(':') : undefined;
};

/** 127.0.0.0/8 and ::1, plus the name that resolves to them. Anything else reaches the LAN. */
const isLoopback = (host: string): boolean =>
  host === '::1' || host === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(host);

/** Every `ports:` entry of every service, tagged with the service that published it. */
const publishedPorts = (
  table: Readonly<Record<string, Service>>,
): readonly { readonly service: string; readonly entry: unknown }[] =>
  Object.entries(table).flatMap(([service, definition]) => {
    const ports = definition['ports'];
    return Array.isArray(ports) ? ports.map((entry) => ({ service, entry })) : [];
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

      test('a role that opens no HTTP socket overrides the image /readyz probe', () => {
        const inherited = roleServices(table).filter((name) => {
          const service = table[name] ?? {};
          // `backfill` declares no ROLE — its own name is the process shape, and it serves nothing.
          const role = roleOf(service) ?? name;
          return !HTTP_ROLES.includes(role) && !overridesImageProbe(service);
        });
        expect(
          inherited,
          `${at}: ${inherited.join(', ')} inherit the image's /readyz HEALTHCHECK and bind no HTTP port, so each reports unhealthy for its whole life — probe METRICS_PORT /metrics, or declare healthcheck: { disable: true } on a run-once service`,
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

describe('every dev compose publishes only to loopback', () => {
  test('the glob found the framework file, both tracked apps and the scaffold', () => {
    // A glob matching nothing agrees with the rule below it.
    expect(shippedDev).toContain(DEV_COMPOSE_FILE);
    expect(devFiles.length).toBeGreaterThanOrEqual(4);
  });

  for (const { at, table } of devFiles) {
    test(`${at} binds every published port to 127.0.0.1`, () => {
      const open = publishedPorts(table)
        .filter(({ entry }) => {
          const host = hostIpOf(entry);
          return host === undefined || !isLoopback(host);
        })
        .map(({ service, entry }) => `${service}: ${Bun.inspect(entry)}`);
      expect(
        open,
        `${at} publishes ${open.join(', ')} on 0.0.0.0 while shipping the credentials in the same file, so anyone on the café wifi has an authenticated database — Docker publishes by writing DNAT rules, which a host firewall does not stop. Write the long form '127.0.0.1:<port>:<port>' and reach it from another machine through a tunnel (ssh -L)`,
      ).toEqual([]);
    });
  }
});
