// The test services run in RAM and say nothing, and a suite finds each one where it was started.
// Reads the REAL files: docker/docker-compose.test.yml (what starts), docker/test-services.env
// (where the suites look) and ci.yml (which part starts what). Three files that have to agree and
// that nothing else compares — a port moved in one of them is a suite that skips under a green run.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { names } from '../packages/cli/src/templates/naming';
import { docsFiles } from '../packages/cli/src/templates/scaffold-docs';
import { ownerOf } from '../packages/cli/src/verify-tests';
import { jobOf, readWorkflow, text } from './lib/ci-workflow-read';
import { corpus } from './lib/corpus';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { ServicePart, ServiceSuite } from './lib/test-service-coverage';
import { requiredServiceUrls, serviceCoverageGaps } from './lib/test-service-coverage';

// Every case reads the real compose files and workflows, so the file runs on the repo-scan budget.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

interface Service {
  readonly image?: string;
  readonly command?: readonly string[];
  readonly entrypoint?: readonly string[];
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

/** `127.0.0.1:5440:5432` → 5440: the port a suite on the host dials. */
const hostPort = (published: string): string => published.split(':').at(-2) ?? '';

const lines = (await Bun.file(`${root}/${ENV_FILE}`).text())
  .split('\n')
  .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)] as const;
  });
const urls = new Map(
  lines.filter(([name]) => name.endsWith('_URL')).map(([name, value]) => [name, new URL(value)]),
);

// The one reader of `.github/workflows/*.yml` the ci-workflow tests share — the same parse and the
// same schema, so this file and `ci-workflow-shape.test.ts` cannot drift on what a job says.
const ci = await readWorkflow('ci.yml');
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * The gate's parts, as the coverage rule reads them: the steps each one runs, the servers it
 * starts and the URLs it exports. One read of the matrix for the whole file — the forward check
 * below and the reverse one beside it must never answer about different parts.
 */
const rows = listOf(jobOf(ci, 'gate').strategy?.matrix?.['include']);
const parts: readonly ServicePart[] = rows.map((raw) => {
  const row = record(raw);
  return {
    part: text(row['part']),
    only: text(row['only'])
      .split(',')
      .filter((name) => name !== ''),
    services: text(row['services'])
      .split(' ')
      .filter((name) => name !== ''),
    urls: text(row['urls'])
      .split('|')
      .filter((name) => name !== ''),
  };
});

/**
 * The env lines that are a FILE, not a URL, each with the URL whose server wrote it — exported by
 * whichever part exports that URL. A new one is a row here, or the assertion below refuses it.
 */
const COMPANIONS: Readonly<Record<string, string>> = {
  TEST_TLS_ROOT_CERT: 'TEST_TLS_REPLICATION_URL',
};

/**
 * The one exception to "mounts no volume" (#519): the TLS suite on the host has to read the CA the
 * server's certificate chains to, so the certificate init writes it into docker/.tls/ and the
 * server reads its pair from there. Data directories stay tmpfs.
 */
const BINDS: Readonly<Record<string, readonly string[]>> = {
  'postgres-tls': ['./.tls:/tls:ro'],
  'postgres-tls-certs': ['.:/docker:ro', './.tls:/docker/.tls'],
};

/**
 * The service URLs a suite reads that NO test service can answer, each with why: the suite skips,
 * named, everywhere — so it is declared here rather than read as a gap. A row whose URL the env
 * file now writes, or that no suite reads, is refused below: the table only shrinks to the truth.
 */
const UNSUPPLIED: Readonly<Record<string, string>> = {};

/** The compose service whose published port a URL dials, or nothing. */
const serviceAt = (url: URL): string | undefined =>
  services.find(([, spec]) => (spec.ports ?? []).some((port) => hostPort(port) === url.port))?.[0];

describe('unit · test services · in RAM, without durability, silent', () => {
  test('every service keeps its data on a tmpfs and mounts no volume but the TLS material', async () => {
    expect(services.length).toBeGreaterThan(0);
    for (const [name, spec] of services) {
      expect(spec.tmpfs?.length ?? 0, `${name} has no tmpfs`).toBeGreaterThan(0);
      expect(spec.volumes ?? [], `${name} mounts a volume`).toEqual(BINDS[name] ?? []);
    }
    // A test server's private key lands there: it must never be one `git add` away.
    expect(await Bun.file(`${root}/.gitignore`).text()).toContain('\ndocker/.tls/\n');
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
        expect(port, `${name} publishes ${port} beyond loopback`).toMatch(
          /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}:/,
        );
      }
    }
  });

  test('both Postgres servers run without fsync, plan without JIT and log nothing below FATAL', () => {
    for (const name of ['postgres', 'postgres-tls']) {
      const initdb = service(name).environment?.['POSTGRES_INITDB_ARGS'] ?? '';
      for (const setting of [
        'fsync=off',
        'synchronous_commit=off',
        'full_page_writes=off',
        'log_min_messages=fatal',
        // A suite's queries are milliseconds: JIT is compile time they never earn back, and an
        // autoanalyze racing a test's own `analyze` is a plan that changes under its assertion.
        'jit=off',
        'autovacuum=off',
      ]) {
        expect(initdb, `${name} is initialised without ${setting}`).toContain(`-c ${setting}`);
      }
      expect(service(name).tmpfs).toEqual(['/var/lib/postgresql/data']);
    }
    expect(service('postgres').image).toStartWith('pgvector/pgvector:');
    expect(service('postgres-tls').command).toContain('wal_level=logical');
    expect(service('postgres-tls').command).toContain('ssl=on');
  });

  // Measured 2026-11-07: the stock 100 was exhausted by 12 parallel test processes on this
  // repo's own suites (`sorry, too many clients already`, read as X_DB_POOL_EXHAUSTED), with a
  // peak of 305 once the ceiling moved. A slot costs ~25 KB of shared memory.
  test('each Postgres server admits every parallel test process at once', () => {
    for (const name of ['postgres', 'postgres-tls']) {
      const initdb = service(name).environment?.['POSTGRES_INITDB_ARGS'] ?? '';
      const ceiling = Number(/-c max_connections=(\d+)/.exec(initdb)?.[1] ?? '100');
      expect(ceiling, `${name} keeps the stock connection ceiling`).toBeGreaterThanOrEqual(400);
    }
  });

  // `wal_level` is a server argument, but TLS is not a property of the server a plain client
  // sees: `host all all all` admits a cleartext session on the same port. So the logical feed's
  // suites and the TLS suite share ONE server, and the cleartext URL says so with sslmode=disable
  // — without it the wire client's default `prefer` would quietly move those suites onto TLS.
  test('one logical server answers both replication URLs, one in cleartext and one over TLS', () => {
    const plain = urls.get('TEST_REPLICATION_URL');
    const tls = urls.get('TEST_TLS_REPLICATION_URL');

    expect(plain && serviceAt(plain)).toBe('postgres-tls');
    expect(tls && serviceAt(tls)).toBe('postgres-tls');
    expect(plain?.searchParams.get('sslmode')).toBe('disable');
    expect(
      services
        .filter(([, spec]) => (spec.command ?? []).join(' ').includes('wal_level=logical'))
        .map(([name]) => name),
    ).toEqual(['postgres-tls']);
  });

  // The standby has no initdb of its own: its postgresql.conf — no fsync, nothing below FATAL — is
  // the one `pg_basebackup` copies off `postgres`, so it is the same image and a clone of that one.
  test('the standby is a streaming clone of the suites server, admitted by one replication line', () => {
    const standby = service('postgres-standby');
    const script = standby.entrypoint?.join(' ') ?? '';
    const primary = service('postgres').entrypoint?.join(' ') ?? '';

    expect(standby.image).toBe(service('postgres').image ?? '');
    expect(standby.tmpfs).toEqual(['/var/lib/postgresql/data']);
    expect(script).toContain('pg_basebackup -h postgres ');
    expect(script).toContain(' -R ');
    // A slot pins WAL on the primary's tmpfs for a standby that may be gone.
    expect(script).not.toMatch(/ (-C|-S|--slot|--create-slot)\b/);
    expect(primary).toContain('host replication all samenet scram-sha-256');
  });

  // What `pooler.live.test.ts` proves is the STOCK config: a bare URL refused at startup. Naming
  // `statement_timeout` in the ignore list turns that into a silent `statement_timeout = 0`.
  test('the pooler is in transaction mode, in front of the suites server, ignoring no bound', () => {
    const environment = service('pooler').environment ?? {};

    expect(service('pooler').image).toStartWith('edoburu/pgbouncer:');
    expect(environment['POOL_MODE']).toBe('transaction');
    expect(environment['DB_HOST']).toBe('postgres');
    expect(environment['IGNORE_STARTUP_PARAMETERS']).toBeUndefined();
    expect(urls.get('TEST_POOLER_URL')?.username).toBe(environment['DB_USER'] ?? '');
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

describe('unit · test services · Dependabot moves the scaffold pin with docker/', () => {
  test('the docker-compose ecosystem watches both directories and groups the gateway', async () => {
    const { updates } = Bun.YAML.parse(await Bun.file(`${root}/.github/dependabot.yml`).text()) as {
      readonly updates: readonly {
        readonly 'package-ecosystem': string;
        readonly directories?: readonly string[];
        readonly groups?: Readonly<Record<string, { readonly patterns?: readonly string[] }>>;
      }[];
    };
    const compose = updates.find((update) => update['package-ecosystem'] === 'docker-compose');
    expect(compose?.directories).toEqual(['/docker', '/packages/cli/src/templates/pinned']);
    expect(Object.values(compose?.groups ?? {}).flatMap((group) => group.patterns)).toContain(
      'versity/versitygw',
    );
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
  test('every URL dials a port exactly one service publishes, and every server has a URL', () => {
    const dialled = [...urls].map(([name, url]) => [name, serviceAt(url)] as const);
    // A one-shot (the certificate init) publishes nothing and is dialled by nobody.
    const servers = services.filter(([, spec]) => (spec.ports ?? []).length > 0);

    expect(dialled.filter(([, at]) => at === undefined)).toEqual([]);
    // A set: one server may answer two URLs (the logical one, in cleartext and over TLS).
    expect([...new Set(dialled.map(([, at]) => at))].sort()).toEqual(
      servers.map(([name]) => name).sort(),
    );
  });

  // Every port binds `127.0.0.1` (above). `localhost` resolves `::1` first on Windows, where
  // nothing listens, so a suite dialled a closed port and skipped under a green run.
  test('every URL dials the IPv4 loopback the ports bind, never a name that resolves ::1', () => {
    const hosts = [...urls].filter(([, url]) => url.hostname !== '127.0.0.1');
    expect(hosts.map(([name, url]) => `${name}=${url.hostname}`)).toEqual([]);
  });

  test('every line that is not a URL rides with the URL whose server wrote it', () => {
    const files = lines.filter(([name]) => !name.endsWith('_URL'));
    expect(files.filter(([name]) => !urls.has(COMPANIONS[name] ?? ''))).toEqual([]);
    expect(Object.fromEntries(files)).toEqual({ TEST_TLS_ROOT_CERT: 'docker/.tls/ca.crt' });
  });

  test('each CI part exports the URLs of exactly the services it started', () => {
    const withServices = parts.filter((part) => part.services.length > 0);

    expect(withServices.length).toBeGreaterThan(0);
    for (const part of parts) {
      const started = part.services;
      const exported = part.urls;
      const served = [...urls]
        .filter(([, url]) => started.includes(serviceAt(url) ?? ''))
        .map(([name]) => name);
      const expected = [
        ...served,
        ...Object.keys(COMPANIONS).filter((file) => served.includes(COMPANIONS[file] ?? '')),
      ];

      expect(
        started.filter((name) => compose.services?.[name] === undefined),
        `${part.part} starts a service ${COMPOSE} does not define`,
      ).toEqual([]);
      expect(
        [...exported].sort(),
        `${part.part} exports URLs for services it did not start`,
      ).toEqual([...expected].sort());
    }
    // One mechanism: a `services:` block beside the compose file is a second way to start one.
    for (const [name, job] of Object.entries(ci.jobs ?? {})) {
      expect(job.services, `${name} declares a services: block`).toBeUndefined();
    }
  });

  // The other direction: a part that exports the URLs of the services it started is only half the
  // rule — a suite that READS a URL needs a part that runs its step to export it, or the suite
  // skips under a green run and the step is green over nothing. The forward check above cannot
  // see this: it asks what a part exports, never what a suite needs.
  test('every suite that reads a service URL is run by a part that exports it', async () => {
    const files = await corpus(root, 'tests');
    const suites: readonly ServiceSuite[] = files.map((file) => ({
      path: file.path,
      step: ownerOf(file.path),
      required: requiredServiceUrls(file.source),
    }));
    // The scope this rule reads is narrowed: the suites that READ a URL. A rename of the
    // `TEST_*_URL` convention would empty that scope and leave the rule green over nothing — so
    // the scope has a floor: at least one suite carries a requirement.
    expect(
      suites.filter((suite) => suite.required.length > 0).length,
      'no suite reads a TEST_*_URL, so this rule watches nothing',
    ).toBeGreaterThan(0);
    const serves = new Map<string, string>(
      [...urls].flatMap(([name, url]) => {
        const at = serviceAt(url);
        return at === undefined ? [] : [[name, at] as const];
      }),
    );
    const gaps = serviceCoverageGaps(suites, parts, serves).filter(
      (gap) => UNSUPPLIED[gap.url] === undefined,
    );

    expect(
      gaps.map((gap) => `${gap.suite} reads ${gap.url}, which no part running its step exports`),
    ).toEqual([]);
    // The exemption is for a URL no service answers and some suite reads — never a way past a gap.
    const read = new Set(suites.flatMap((suite) => suite.required));
    for (const url of Object.keys(UNSUPPLIED)) {
      expect(urls.has(url), `${url} is in ${ENV_FILE}: drop its UNSUPPLIED row`).toBe(false);
      expect(read.has(url), `no suite reads ${url}: drop its UNSUPPLIED row`).toBe(true);
    }
  });
});
