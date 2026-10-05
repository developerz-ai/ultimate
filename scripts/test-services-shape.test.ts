// The test services run in RAM and say nothing, and a suite finds each one where it was started.
// Reads the REAL files: docker/docker-compose.test.yml (what starts), docker/test-services.env
// (where the suites look) and ci.yml (which part starts what). Three files that have to agree and
// that nothing else compares — a port moved in one of them is a suite that skips under a green run.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { names } from '../packages/cli/src/templates/naming';
import { docsFiles } from '../packages/cli/src/templates/scaffold-docs';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Every case reads the real compose files and workflows, so the file runs on the repo-scan budget.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Service {
  readonly image?: string;
  readonly command?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly tmpfs?: readonly string[];
  readonly volumes?: readonly string[];
  readonly ports?: readonly string[];
  readonly logging?: { readonly driver?: string };
  readonly healthcheck?: { readonly test?: readonly string[] };
}

const COMPOSE = 'docker/docker-compose.test.yml';
const ENV_FILE = 'docker/test-services.env';

const root = repoRoot();
const compose = Bun.YAML.parse(await Bun.file(`${root}/${COMPOSE}`).text()) as {
  readonly services?: Readonly<Record<string, Service>>;
};
const services = Object.entries(compose.services ?? {});
const service = (name: string): Service => compose.services?.[name] ?? {};

/** `127.0.0.1:5433:5432` → 5433: the port a suite on the host dials. */
const hostPort = (published: string): string => published.split(':').at(-2) ?? '';

const urls = new Map(
  (await Bun.file(`${root}/${ENV_FILE}`).text())
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), new URL(line.slice(at + 1))] as const;
    }),
);

/** The compose service whose published port a URL dials, or nothing. */
const serviceAt = (url: URL): string | undefined =>
  services.find(([, spec]) => (spec.ports ?? []).some((port) => hostPort(port) === url.port))?.[0];

describe('unit · test services · in RAM, without durability, silent', () => {
  test('every service keeps its data on a tmpfs and mounts no volume', () => {
    expect(services.length).toBeGreaterThan(0);
    for (const [name, spec] of services) {
      expect(spec.tmpfs?.length ?? 0, `${name} has no tmpfs`).toBeGreaterThan(0);
      expect(spec.volumes, `${name} mounts a volume`).toBeUndefined();
    }
  });

  test('every service has the `none` log driver, so nothing is kept and nothing is printed', () => {
    for (const [name, spec] of services) {
      expect(spec.logging?.driver, `${name} keeps a container log`).toBe('none');
    }
  });

  test('every service has a healthcheck — `up --wait` is the only readiness there is', () => {
    for (const [name, spec] of services) {
      expect(spec.healthcheck?.test?.length ?? 0, `${name} has no healthcheck`).toBeGreaterThan(0);
    }
  });

  test('every published port binds loopback: the credentials are in the file', () => {
    for (const [name, spec] of services) {
      for (const port of spec.ports ?? []) {
        expect(port, `${name} publishes ${port} on every interface`).toStartWith('127.0.0.1:');
      }
    }
  });

  test('both Postgres servers run without fsync and log nothing below FATAL', () => {
    for (const name of ['postgres', 'postgres-logical']) {
      const initdb = service(name).environment?.['POSTGRES_INITDB_ARGS'] ?? '';
      for (const setting of [
        'fsync=off',
        'synchronous_commit=off',
        'full_page_writes=off',
        'log_min_messages=fatal',
      ]) {
        expect(initdb, `${name} is initialised without ${setting}`).toContain(`-c ${setting}`);
      }
      expect(service(name).tmpfs).toEqual(['/var/lib/postgresql/data']);
    }
    expect(service('postgres').image).toStartWith('pgvector/pgvector:');
    expect(service('postgres-logical').command).toContain('wal_level=logical');
  });

  test('Redis keeps no snapshot and no append-only file', () => {
    const command = (service('redis').command ?? []).join(' ');
    expect(command).toContain('--save  --appendonly no');
    expect(command).toContain('--loglevel nothing');
  });

  test('the S3 server is not MinIO, and its bucket is the tmpfs', () => {
    const s3 = service('s3');
    const bucket = urls.get('TEST_S3_URL')?.pathname ?? '';

    expect(s3.image).not.toContain('minio');
    expect(bucket.length).toBeGreaterThan(1);
    expect(s3.tmpfs).toEqual([`${s3.environment?.['VGW_BACKEND_ARG']}${bucket}`]);
    expect(urls.get('TEST_S3_URL')?.username).toBe(s3.environment?.['ROOT_ACCESS_KEY'] ?? '');
    expect(urls.get('TEST_S3_URL')?.password).toBe(s3.environment?.['ROOT_SECRET_KEY'] ?? '');
  });
});

describe('unit · test services · one S3 server, wherever this repo starts one', () => {
  const DEV = 'docker/docker-compose.dev.yml';
  const imagesOf = (yaml: string): readonly string[] =>
    Object.values(
      (Bun.YAML.parse(yaml) as { services?: Readonly<Record<string, Service>> }).services ?? {},
    ).map((spec) => spec.image ?? '');

  test('the test stack, the dev stack and a scaffolded app run the same image, and never MinIO', async () => {
    const scaffolded = docsFiles(names('demoapp')).find((file) => file.path === DEV)?.contents;
    const stacks = {
      [COMPOSE]: imagesOf(await Bun.file(`${root}/${COMPOSE}`).text()),
      [DEV]: imagesOf(await Bun.file(`${root}/${DEV}`).text()),
      [`x new → ${DEV}`]: imagesOf(typeof scaffolded === 'string' ? scaffolded : ''),
    };
    const s3 = service('s3').image ?? '';
    const regionsOf = (yaml: string): readonly string[] =>
      Object.values(
        (Bun.YAML.parse(yaml) as { services?: Readonly<Record<string, Service>> }).services ?? {},
      )
        .filter((spec) => (spec.image ?? '').startsWith('versity/versitygw:'))
        .map((spec) => spec.environment?.['VGW_REGION'] ?? '(unset)');
    const gatewayRegions = {
      [COMPOSE]: regionsOf(await Bun.file(`${root}/${COMPOSE}`).text()),
      [DEV]: regionsOf(await Bun.file(`${root}/${DEV}`).text()),
      [`x new → ${DEV}`]: regionsOf(typeof scaffolded === 'string' ? scaffolded : ''),
    };

    expect(s3).toMatch(/^versity\/versitygw:v\d+\.\d+\.\d+(@sha256:[0-9a-f]{64})?$/);
    // The region `Bun.S3Client` signs for when an app sets no S3_REGION: a gateway started with
    // any other refuses that app's first upload.
    for (const [at, regions] of Object.entries(gatewayRegions)) {
      expect(
        regions,
        `${at} starts the gateway outside the region an unset S3_REGION signs for`,
      ).toEqual(['auto']);
    }
    for (const [at, images] of Object.entries(stacks)) {
      expect(images, `${at} does not run ${s3}`).toContain(s3);
      expect(
        images.filter((image) => image.includes('minio')),
        `${at} runs MinIO`,
      ).toEqual([]);
    }
  });
});

describe('unit · test services · no compose file this repo ships starts MinIO', () => {
  test('every docker-compose file at the root and in both tracked apps', async () => {
    const files = ['docker', 'examples/*/docker', 'dummy/*/docker'].flatMap((dir) => [
      ...new Bun.Glob(`${dir}/docker-compose*.yml`).scanSync({ cwd: root }),
    ]);
    // A glob matching nothing agrees with the rule below it.
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const at of files) {
      expect(
        (await Bun.file(`${root}/${at}`).text()).toLowerCase(),
        `${at} names MinIO`,
      ).not.toContain('minio');
    }
  });
});

describe('unit · test services · every image is a tag pinned by digest', () => {
  // A tag is a pointer its publisher can move: the same commit could start a different server
  // tomorrow. The tag stays for the reader; the multi-arch index digest is what runs.
  const PINNED = /^[a-z0-9][a-z0-9./_-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;

  for (const file of [COMPOSE, 'docker/docker-compose.dev.yml']) {
    test(file, async () => {
      const specs = Object.entries(
        (
          Bun.YAML.parse(await Bun.file(`${root}/${file}`).text()) as {
            services?: Readonly<Record<string, Service>>;
          }
        ).services ?? {},
      );
      // A file that parses to no services agrees with the rule below it.
      expect(specs.length).toBeGreaterThan(0);
      const unpinned = specs
        .filter(([, spec]) => !PINNED.test(spec.image ?? ''))
        .map(([name, spec]) => `${name}: ${spec.image ?? '(no image)'}`);
      expect(
        unpinned,
        `${file}: pin each as name:tag@sha256:<digest> — \`docker buildx imagetools inspect <name:tag>\` prints the index digest`,
      ).toEqual([]);
    });
  }
});

describe('unit · test services · a suite finds each one where it was started', () => {
  test('every URL dials a port exactly one service publishes, and every service has a URL', () => {
    const dialled = [...urls].map(([name, url]) => [name, serviceAt(url)] as const);

    expect(dialled.filter(([, at]) => at === undefined)).toEqual([]);
    expect(dialled.map(([, at]) => at).sort()).toEqual(services.map(([name]) => name).sort());
  });

  test('each CI part exports the URLs of exactly the services it started', async () => {
    const ci = Bun.YAML.parse(await Bun.file(`${root}/.github/workflows/ci.yml`).text()) as {
      readonly jobs?: Readonly<
        Record<
          string,
          { readonly services?: unknown; readonly strategy?: { readonly matrix?: unknown } }
        >
      >;
    };
    const include = (ci.jobs?.['gate']?.strategy?.matrix as { include?: unknown } | undefined)
      ?.include;
    const parts = (Array.isArray(include) ? include : []) as readonly Readonly<
      Record<string, string | undefined>
    >[];
    const withServices = parts.filter((part) => part['services'] !== undefined);

    expect(withServices.length).toBeGreaterThan(0);
    for (const part of parts) {
      const started = (part['services'] ?? '').split(' ').filter((name) => name !== '');
      const exported = (part['urls'] ?? '').split('|').filter((name) => name !== '');
      const expected = [...urls]
        .filter(([, url]) => started.includes(serviceAt(url) ?? ''))
        .map(([name]) => name);

      expect(
        started.filter((name) => compose.services?.[name] === undefined),
        `${part['part']} starts a service ${COMPOSE} does not define`,
      ).toEqual([]);
      expect(
        [...exported].sort(),
        `${part['part']} exports URLs for services it did not start`,
      ).toEqual([...expected].sort());
    }
    // One mechanism: a `services:` block beside the compose file is a second way to start one.
    for (const [name, job] of Object.entries(ci.jobs ?? {})) {
      expect(job.services, `${name} declares a services: block`).toBeUndefined();
    }
  });
});
