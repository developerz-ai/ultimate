// The test stack `x new` writes: in RAM, no durability, no logs — and the env file names exactly
// the ports the compose file publishes, so a suite cannot dial a server nothing started.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import {
  TEST_COMPOSE_PATH,
  TEST_ENV_PATH,
  TEST_PORT_SPREAD,
  TEST_PORTS,
  testPorts,
  testProjectName,
  testServicesFiles,
} from './scaffold-test-services';

interface Service {
  readonly image: string;
  readonly command?: readonly string[];
  readonly environment?: Record<string, string>;
  readonly tmpfs?: readonly string[];
  readonly volumes?: readonly string[];
  readonly ports: readonly string[];
  readonly logging?: { readonly driver?: string };
}

const files = testServicesFiles(names('shop'));
const fileAt = (path: string): string => {
  const contents = files.find((file) => file.path === path)?.contents ?? '';
  return typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
};
const services = (): Record<string, Service> =>
  (Bun.YAML.parse(fileAt(TEST_COMPOSE_PATH)) as { services: Record<string, Service> }).services;

describe('unit · the scaffolded test stack is fast and silent', () => {
  test('every service lives in RAM, publishes loopback only and logs nowhere', () => {
    const all = Object.entries(services());
    expect(all.map(([name]) => name).sort()).toEqual(['nats', 'postgres', 'redis', 's3']);
    for (const [name, service] of all) {
      expect([name, service.logging?.driver]).toEqual([name, 'none']);
      expect([name, (service.tmpfs ?? []).length > 0]).toEqual([name, true]);
      expect([name, service.volumes]).toEqual([name, undefined]);
      for (const port of service.ports) expect(port).toStartWith('127.0.0.1:');
    }
  });

  test('Postgres is the production major with durability and logging off', () => {
    const postgres = services()['postgres'];
    expect(postgres?.image).toBe('postgres:18-alpine');
    // Postgres 18 images keep the cluster under /var/lib/postgresql/18: the tmpfs is the parent.
    expect(postgres?.tmpfs).toEqual(['/var/lib/postgresql']);
    const initdb = postgres?.environment?.['POSTGRES_INITDB_ARGS'] ?? '';
    for (const setting of [
      '--no-sync',
      'fsync=off',
      'synchronous_commit=off',
      'full_page_writes=off',
      'wal_level=minimal',
      'max_wal_senders=0',
      'logging_collector=off',
      'log_min_messages=fatal',
      'log_statement=none',
      // Throughput for millisecond queries, and a WAL kept small because it is RAM.
      'jit=off',
      'autovacuum=off',
      'min_wal_size=32MB',
    ]) {
      expect(initdb).toContain(setting);
    }
    // The stock 100 runs out under a laptop's worth of parallel test processes.
    expect(Number(/max_connections=(\d+)/.exec(initdb)?.[1] ?? '100')).toBeGreaterThanOrEqual(400);
  });

  test('Redis keeps no snapshot and no append-only file, and logs nothing', () => {
    expect(services()['redis']?.command).toEqual([
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
      '--loglevel',
      'nothing',
    ]);
  });

  test('the env file names exactly the ports the compose file publishes', () => {
    const env = fileAt(TEST_ENV_PATH);
    const published = Object.values(services()).map((service) =>
      Number(service.ports[0]?.split(':')[1]),
    );
    const ports = testPorts(names('shop'));
    expect(published.sort()).toEqual(Object.values(ports).sort());
    for (const port of Object.values(ports)) expect(env).toContain(`127.0.0.1:${port}`);
    expect(env).toContain(
      `TEST_DATABASE_URL=postgres://shop:shop-test@127.0.0.1:${ports.postgres}/`,
    );
  });

  // Two scaffolds on one machine shared 55432, and the second app's live suites ran against the
  // first app's container (28P01). Each app's ports are its own, stable, inside its service's band.
  test('each app gets its own ports, stable across runs, inside each service band', () => {
    const shop = testPorts(names('shop'));
    const ledger = testPorts(names('ledger-demo'));
    expect(testPorts(names('shop'))).toEqual(shop);
    // Pinned: dummy/docs-site's committed stack was generated from these, so a change to the
    // derivation is a regenerate of every tracked app's stack, never a silent move.
    expect(testPorts(names('docs-site'))).toEqual({
      postgres: 55838,
      redis: 56785,
      nats: 54628,
      s3: 59406,
    });
    expect(shop.postgres).not.toBe(ledger.postgres);
    for (const ports of [shop, ledger]) {
      for (const key of Object.keys(TEST_PORTS) as (keyof typeof TEST_PORTS)[]) {
        expect(ports[key] - TEST_PORTS[key]).toBeGreaterThanOrEqual(0);
        expect(ports[key] - TEST_PORTS[key]).toBeLessThan(TEST_PORT_SPREAD);
      }
    }
  });
});

// Two scaffolds of one name on one machine shared `<name>-test`: the second one's gate met the
// first one's stack, stopped or not. A scaffold that knows its root names its stack for it.
describe('unit · a scaffold that knows its root owns its compose project and ports', () => {
  const composeOf = (root?: string) => {
    const file = testServicesFiles(names('shop'), root).find((f) => f.path === TEST_COMPOSE_PATH);
    return (Bun.YAML.parse(String(file?.contents)) as { name: string }).name;
  };

  test('the project name carries a hash of the root, stable, and differs per root', () => {
    expect(composeOf('/home/a/shop')).toBe(testProjectName(names('shop'), '/home/a/shop'));
    expect(composeOf('/home/a/shop')).toMatch(/^shop-test-[0-9a-f]{8}$/);
    expect(composeOf('/home/a/shop')).toBe(composeOf('/home/a/shop'));
    expect(composeOf('/home/a/shop')).not.toBe(composeOf('/tmp/b/shop'));
  });

  test('two roots get different ports, and the env file names the ones published', () => {
    const one = testPorts(names('shop'), '/home/a/shop');
    expect(one).not.toEqual(testPorts(names('shop'), '/tmp/b/shop'));
    const env = testServicesFiles(names('shop'), '/home/a/shop').find(
      (f) => f.path === TEST_ENV_PATH,
    );
    expect(String(env?.contents)).toContain(`127.0.0.1:${one.postgres}/`);
  });

  test('without a root, the bytes are exactly what every earlier scaffold wrote', () => {
    expect(composeOf()).toBe('shop-test');
    expect(testPorts(names('shop'), undefined)).toEqual(testPorts(names('shop')));
  });
});
