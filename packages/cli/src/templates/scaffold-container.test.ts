// The generated compose file is the deploy story in a file, and a service that is silently the
// wrong process is the one failure a rolling deploy cannot see. Asserted at the template, because
// the alternative is discovering it in whoever's production ran `x new` first.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { SECRETS_KEY_FILE } from '@ultimat3/core';
import { PREBUILT_COMMAND, PREBUILT_DIR } from '../serve-prebuilt-paths';
import { names } from './naming';
import { containerFiles } from './scaffold-container';

/**
 * Docker's own matcher, in the lines it takes: a pattern is ANCHORED at the context root, `*` stops
 * at a separator, `**` crosses them (zero directories included), and the LAST line that matches
 * decides. Written out because that anchoring is the whole bug — reading `.env` as "every .env" is
 * the assumption that put three of them in a published layer.
 */
const toRegex = (pattern: string): RegExp => {
  const source = pattern
    .split('/')
    .map((segment) =>
      segment === '**'
        ? '\0'
        : segment.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*'),
    )
    .join('/')
    .replaceAll('\0/', '(?:[^/]+/)*')
    .replaceAll('\0', '.*');
  return new RegExp(`^${source}(?:/.*)?$`);
};

/** Whether a build context path reaches the image, judged by the ignore file the scaffold writes. */
const ignored = (ignoreFile: string, path: string): boolean => {
  let hit = false;
  for (const line of ignoreFile.split('\n')) {
    const raw = line.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const negated = raw.startsWith('!');
    if (toRegex(negated ? raw.slice(1) : raw).test(path)) hit = !negated;
  }
  return hit;
};

const APP = names('my-app');

const fileAt = (path: string): string => {
  const found = containerFiles(APP).find((file) => file.path === path);
  if (found === undefined) return expect.unreachable(`no generated ${path}`);
  // `GeneratedSourceFile.contents` admits raw bytes for `x new`'s PNG icon; every container file
  // is text, so bytes reaching a compose/Dockerfile reader are the failure.
  return typeof found.contents === 'string'
    ? found.contents
    : expect.unreachable(`${path} is bytes, not text`);
};

/** Each `services:` entry as its own text, keyed by name — services sit at exactly two spaces. */
function serviceBlocks(compose: string): ReadonlyMap<string, string> {
  const lines = compose.split('\n');
  const start = lines.indexOf('services:');
  const blocks = new Map<string, string>();
  let name: string | undefined;
  let body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}(?<name>[a-z][\w-]*):\s*$/.exec(line)?.groups?.['name'];
    if (header !== undefined) {
      if (name !== undefined) blocks.set(name, body.join('\n'));
      name = header;
      body = [];
      continue;
    }
    // A line at column 0 that is not a service header ends the section (`volumes:`).
    if (line.length > 0 && !line.startsWith(' ')) break;
    body.push(line);
  }
  if (name !== undefined) blocks.set(name, body.join('\n'));
  return blocks;
}

describe('unit · the scaffolded container files', () => {
  // The image's ENTRYPOINT is `bun apps/web/server.ts`, and that entry reads ROLE and PORT and
  // NOTHING ELSE — argv never reaches a parser. A `command:` beside it is therefore appended to a
  // process that discards it, so `backfill` served HTTP as ROLE=web, forever, under a name that
  // said otherwise. A `command:` only means something with an `entrypoint:` that reads argv.
  test('every service that declares a command also overrides the entrypoint', () => {
    for (const [name, body] of serviceBlocks(fileAt('docker/docker-compose.prod.yml'))) {
      if (!body.includes('command:')) continue;
      expect(`${name}: ${body}`).toContain('entrypoint:');
    }
  });

  test('the backfill service runs the CLI, and asks for the write explicitly', () => {
    const backfill = serviceBlocks(fileAt('docker/docker-compose.prod.yml')).get('backfill');
    expect(backfill).toContain("entrypoint: ['bun', 'node_modules/@ultimat3/cli/src/bin.ts']");
    expect(backfill).toContain("command: ['db', 'backfill', '--all', '--write', '--json']");
  });

  // ROLE is the one knob the image's own entry point reads, so every role service must set it.
  test('every serving role selects itself through ROLE, never through argv', () => {
    for (const role of ['migrate', 'web', 'sync', 'worker', 'scheduler']) {
      expect(serviceBlocks(fileAt('docker/docker-compose.prod.yml')).get(role)).toContain(
        // A prefix, not the whole list: `web` also requires SYNC_URL beside it.
        `environment: [ROLE=${role}`,
      );
    }
  });
});

// The image's build stage is `COPY . .`, so what the ignore file misses is a layer — one that
// `cache-to=type=gha,mode=max` then pushes to a shared cache. `.env` and `.env.*.local` are
// anchored at the context root and cross no directory, so `.env.production` — the file the
// scaffold's OWN `docker-compose.prod.yml` tells the operator to create, in `env_file:` — matched
// NEITHER, and shipped. Reproduced against a real `docker build`: three `.env*` files in `/app`.
describe('unit · no secret reaches the image the scaffold builds', () => {
  const ignoreFile = (): string => fileAt('docker/Dockerfile.dockerignore');

  test('every .env is ignored at any depth, and only .env.example survives', () => {
    for (const path of [
      '.env',
      '.env.production',
      '.env.development',
      '.env.local',
      '.env.production.local',
      'apps/web/.env',
      'apps/web/.env.production',
      '.npmrc',
      'apps/web/.npmrc',
    ]) {
      expect([path, ignored(ignoreFile(), path)]).toEqual([path, true]);
    }
    // The committed template is the one file here that must survive: an image built without it
    // has no example env for a `docker run` to read, and it holds no secret by construction.
    expect(ignored(ignoreFile(), '.env.example')).toBe(false);
  });

  // The `.env` block is not the whole of it, and the file this one names is worse than an `.env`:
  // `.secrets.key` DECRYPTS `secrets.enc.json`, which is committed — so a key in a layer publishes
  // every secret the app has, and `findMasterKey` (packages/core/src/secrets-store.ts) falls back
  // to the file whenever ULTIMATE_SECRETS_KEY is unset, so the container silently boots on the
  // baked one and the platform's key is never exercised. `wiki/CLI-Reference.md` states the
  // invariant — "a container is handed its key by the platform and ships no key file at all".
  test('the master key is ignored at any depth, and the pattern is core’s own filename', () => {
    for (const path of [SECRETS_KEY_FILE, `apps/web/${SECRETS_KEY_FILE}`]) {
      expect([path, ignored(ignoreFile(), path)]).toEqual([path, true]);
    }
    // Read off the constant `findMasterKey` reads, never spelled here: renaming the key file
    // would otherwise leave every generated app's ignore line protecting a name nothing writes.
    expect(ignoreFile()).toContain(`**/${SECRETS_KEY_FILE}`);
  });

  // The matcher above must be able to answer "no", or the assertions it backs cannot fail.
  test('the ignore file still lets the app source through, and still drops node_modules', () => {
    expect(ignored(ignoreFile(), 'apps/web/server.ts')).toBe(false);
    expect(ignored(ignoreFile(), 'node_modules/@ultimat3/cli/src/bin.ts')).toBe(true);
    expect(ignored(ignoreFile(), 'apps/web/node_modules/x')).toBe(true);
  });
});

// `x deploy --method helm` runs `helm upgrade --install app <root>/docker/helm`, and until this
// existed the chart was in NO npm tarball — `packages/cli`'s `files:` ships `src` and nothing else
// — so the refusal's own fix, "copy docker/helm from the framework repo", named a repository an
// installed app never had. `x new` already writes the other method's topology file one line away.
describe('unit · the scaffold writes the chart x deploy --method helm runs', () => {
  const chartFiles = (): readonly string[] =>
    containerFiles(APP)
      .map((file) => file.path)
      .filter((path) => path.startsWith('docker/helm/'));

  test('the chart is a chart: Chart.yaml, values.yaml and a templates directory', () => {
    expect(chartFiles()).toContain('docker/helm/Chart.yaml');
    expect(chartFiles()).toContain('docker/helm/values.yaml');
    expect(
      chartFiles().filter((path) => path.startsWith('docker/helm/templates/')).length,
    ).toBeGreaterThan(0);
  });

  test('Chart.yaml and values.yaml are YAML, and Chart.yaml names an appVersion', () => {
    const parsed = Bun.YAML.parse(fileAt('docker/helm/Chart.yaml')) as Record<string, unknown>;
    expect(parsed['apiVersion']).toBe('v2');
    expect(parsed['name']).toBe(APP.kebab);
    // The default image tag, so it must be a string a registry could hold — never empty.
    expect(String(parsed['appVersion'] ?? '')).not.toBe('');
    expect(Bun.YAML.parse(fileAt('docker/helm/values.yaml'))).toBeTypeOf('object');
  });

  // `helmImageOverrides` passes `--set-string image.repository=` / `image.tag=` because the chart
  // renders `repository:tag`. A values file declaring `image` as a STRING would take those two
  // keys and render no workload at all — and `planDeploy` refuses a digest on the same grounds.
  test('image is the map x deploy overrides, read as repository:tag', () => {
    const values = Bun.YAML.parse(fileAt('docker/helm/values.yaml')) as {
      image?: Record<string, unknown>;
    };
    expect(values.image).toBeTypeOf('object');
    expect(values.image?.['repository']).toBeTypeOf('string');
    expect(values.image?.['tag']).toBe('');
    expect(fileAt('docker/helm/templates/_helpers.tpl')).toContain(
      'printf "%s:%s" (toString $repository) (toString (default .Chart.AppVersion .Values.image.tag))',
    );
  });

  // Not `helm template` — no helm binary is assumed here — but the two structural mistakes that
  // stop one rendering: an unbalanced action, and a `define` with no `end`.
  test('every template action is closed, and every define ends', () => {
    for (const path of chartFiles().filter((entry) => entry.includes('/templates/'))) {
      const text = fileAt(path);
      expect([path, text.split('{{').length]).toEqual([path, text.split('}}').length]);
      const opens = text.match(/\{\{-?\s*define\b/g)?.length ?? 0;
      const ends = text.match(/\{\{-?\s*end\s*-?\}\}/g)?.length ?? 0;
      expect([path, ends >= opens]).toEqual([path, true]);
    }
  });

  // A role the workloads range over that values.yaml never declares is a Deployment nobody can
  // enable, and a role in values with no ROLE behind it is a pod that serves nothing.
  test('every role the chart declares is one the image can actually be', () => {
    const values = Bun.YAML.parse(fileAt('docker/helm/values.yaml')) as {
      roles?: Record<string, { enabled?: boolean; port?: number }>;
    };
    const declared = Object.keys(values.roles ?? {});
    expect(declared.length).toBeGreaterThan(0);
    // The same closed set `apps/web/server.ts` selects on, and the same one compose names.
    for (const role of declared) {
      expect([role, ['web', 'sync', 'worker', 'scheduler', 'replicator'].includes(role)]).toEqual([
        role,
        true,
      ]);
    }
    // The sync node binds PORT + 1, so its listening port must be one above web's or the
    // readiness probe polls a socket nobody bound.
    expect(values.roles?.['sync']?.port).toBe((values.roles?.['web']?.port ?? 0) + 1);
  });
});

describe('unit · a probe follows the ROLE, never the image`s ENV', () => {
  /**
   * The chart honours the PORT + 1 rule (the test above, and `scaffold-helm-templates.ts` derives
   * `PORT = $cfg.port - 1`); compose did not. The image's `HEALTHCHECK` fetches `$PORT/readyz` and
   * the Dockerfile sets `PORT=3000`, so `sync` — which binds `PORT + 1` and publishes `3001:3001`
   * — inherited a probe aimed at a socket it never opens: `unhealthy` from `start_period` onward,
   * for the life of the container, and anything gated on `service_healthy` never starts.
   *
   * Stated as the general rule rather than as "sync", so a sixth role that binds its own port is
   * held to it the day it is added.
   */
  test('a service binding a port other than the image PORT declares a probe aimed at THAT port', () => {
    // The `ENV` block's own line — anchored, because a `docker run -e PORT=8080` in a usage
    // comment further up is not what the image sets.
    const imagePort = /^\s+PORT=(?<port>\d+)/m.exec(fileAt('docker/Dockerfile'))?.groups?.['port'];
    expect(imagePort).toBe('3000');
    let checked = 0;
    for (const [name, body] of serviceBlocks(fileAt('docker/docker-compose.prod.yml'))) {
      const bound = /ports: \['\d+:(?<port>\d+)'\]/.exec(body)?.groups?.['port'];
      // No published port, or it publishes the one the inherited probe already fetches.
      if (bound === undefined || bound === imagePort) continue;
      checked += 1;
      expect(`${name} publishes :${bound} and declares no probe of its own:\n${body}`).toContain(
        'healthcheck:',
      );
      expect(`${name}'s probe does not fetch :${bound}:\n${body}`).toContain(
        `127.0.0.1:${bound}/readyz`,
      );
    }
    // The rule is only worth anything if a service actually meets its precondition.
    expect(checked).toBeGreaterThan(0);
  });

  test('sync is that service, and it publishes the port the sync role really binds', () => {
    const sync = serviceBlocks(fileAt('docker/docker-compose.prod.yml')).get('sync');
    // `role-sync.ts` listens on `options.port + 1`, and PORT is unset here, so PORT is 3000.
    expect(sync).toContain("ports: ['3001:3001']");
    expect(sync).toContain('healthcheck:');
  });
});

describe('the scaffolded compose file names where a page dials the sync socket', () => {
  test('web REQUIRES SYNC_URL, because :3000 does not serve /_x/sync on this rung', () => {
    const compose = containerFiles(names('demo')).find(
      (file) => file.path === 'docker/docker-compose.prod.yml',
    );
    const services = (
      Bun.YAML.parse(String(compose?.contents)) as {
        services: Record<string, { environment?: readonly string[] }>;
      }
    ).services;

    // `:?`, never `:-`: a default would be a URL nothing publishes, dialled silently.
    expect(services['web']?.environment).toContainEqual(
      expect.stringMatching(/^SYNC_URL=\$\{SYNC_URL:\?.+\}$/),
    );
  });
});

/** The stage a Dockerfile names `AS <name>`, as its own text up to the next `FROM`. */
function stage(dockerfile: string, name: string): string {
  const start = dockerfile.search(new RegExp(`^FROM .+ AS ${name}$`, 'm'));
  if (start < 0) return expect.unreachable(`no "${name}" stage`);
  const next = dockerfile.slice(start + 1).search(/^FROM /m);
  return next < 0 ? dockerfile.slice(start) : dockerfile.slice(start, start + 1 + next);
}

describe('unit · the scaffolded image installs from manifests, not from source', () => {
  // `COPY apps ./apps` and `COPY packages ./packages` ahead of `bun install` keyed the install
  // layer on every source file, so an edit to one page reinstalled every dependency.
  test('the install stage copies manifests and the lockfile, never a source tree', () => {
    const dockerfile = fileAt('docker/Dockerfile');
    const deps = stage(dockerfile, 'deps');
    expect(deps).toContain('bun install --frozen-lockfile --production');
    const copies = deps.split('\n').filter((line) => line.startsWith('COPY '));
    expect(copies).toEqual(['COPY --from=manifests /app ./', 'COPY bun.lock ./']);
    // ...and the manifests stage keeps exactly the files the install reads.
    expect(stage(dockerfile, 'manifests')).toContain(
      "find . ! -type d ! -name package.json ! -name bunfig.toml ! -name '*.tgz' -delete",
    );
  });

  // Bun's isolated linker links a workspace's dependencies under ITS OWN node_modules, so copying
  // only the root `node_modules` left `apps/web/node_modules` behind and the import failed at boot.
  test('the runtime takes every installed node_modules tree, then the source on top', () => {
    const dockerfile = fileAt('docker/Dockerfile');
    // Built on `deps`, never a COPY of its root `node_modules` alone.
    expect(dockerfile).toContain('FROM deps AS runtime');
    const copies = stage(dockerfile, 'runtime')
      .split('\n')
      .filter((line) => line.startsWith('COPY '));
    expect(copies).toEqual(['COPY . .']);
  });
});

// A web pod boots from what the image build wrote. The store was written by `x build` on the HOST,
// under `.x/` — which every ignore file drops — so no image ever carried one, and every pod ran
// Babel and Sass over the whole app on every start (reference app: 3.7 s and 6.9 CPU-seconds).
describe('the image prebuilds what a web pod would otherwise build at every boot', () => {
  const REPO = join(import.meta.dir, '..', '..', '..', '..');
  /** The runtime stage's instructions, comments dropped, in order. */
  const runtimeStage = (dockerfile: string): readonly string[] => {
    const lines = dockerfile.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    const from = lines.findIndex((line) => /^FROM .* AS runtime$/.test(line));
    expect(from).toBeGreaterThan(-1);
    return lines.slice(from);
  };
  const assertPrebuilt = (dockerfile: string): void => {
    const stage = runtimeStage(dockerfile);
    const copy = stage.indexOf('COPY . .');
    const run = stage.indexOf(`RUN ${PREBUILT_COMMAND}`);
    const stamp = stage.indexOf('ARG BUILD_ID=');
    // After the source is in place; before the stamp, so two builds of one tree share the layer.
    expect([copy > -1, run > copy, stamp > run]).toEqual([true, true, true]);
    // With no deployment environment: `app.config.ts` validates its env on import, and under
    // NODE_ENV=production it asks for values no image build has (`APP_URL`, the secrets).
    const production = stage.findIndex((line) => line.startsWith('ENV NODE_ENV=production'));
    expect(production).toBeGreaterThan(run);
  };

  test('the scaffolded Dockerfile runs it in the runtime stage, above the build stamp', () => {
    assertPrebuilt(fileAt('docker/Dockerfile'));
  });

  test('both tracked apps’ Dockerfiles run the same line', async () => {
    for (const file of [
      'examples/dummy/docker/Dockerfile',
      'dummy/social-media-clone/docker/Dockerfile',
      'dummy/social-media-clone/docker/Dockerfile.monorepo',
    ]) {
      assertPrebuilt(await Bun.file(join(REPO, file)).text());
    }
  });

  test('a store made on the host never enters the context: the image’s own Bun writes it', () => {
    expect(
      ignored(fileAt('docker/Dockerfile.dockerignore'), `${PREBUILT_DIR}/islands/index.json`),
    ).toBe(true);
  });
});

// The Dockerfile chowns `/app/.x` to its runtime user and the chart's pod security context runs the
// process as a uid of its own: two numbers for one user, and the chart's was distroless'
// `nonroot` (65532) on an alpine image that has no such user — a pod that cannot write the one
// directory the image prepared for it. `BASE_IMAGE_UIDS` is what `docker run --rm --entrypoint id
// <image> bun` printed for the series the scaffold pins (2026-10-06): a new base image is a new
// row, measured, never a guess.
describe('unit · the image and the chart run the process as one uid', () => {
  const BASE_IMAGE_UIDS: Readonly<Record<string, number>> = { 'oven/bun:1.4-alpine': 1000 };

  const runtime = (): { readonly user: string; readonly chown: string; readonly base: string } => {
    const dockerfile = fileAt('docker/Dockerfile');
    const users = [...dockerfile.matchAll(/^USER (\S+)$/gm)].map((match) => match[1] ?? '');
    const chown = /chown -R (\S+) \/app\/\.x/.exec(dockerfile)?.[1];
    const base = /^FROM ([^@\s]+)@/m.exec(dockerfile)?.[1];
    expect(users).toHaveLength(1);
    if (chown === undefined || base === undefined) return expect.unreachable('no chown or FROM');
    return { user: users[0] ?? '', chown, base };
  };

  test('USER is numeric, so a kubelet can verify runAsNonRoot without the chart', () => {
    expect(runtime().user).toMatch(/^\d+:\d+$/);
  });

  test('the uid is the base image`s own bun user, as measured', () => {
    const { user, base } = runtime();
    const measured = BASE_IMAGE_UIDS[base];
    if (measured === undefined) return expect.unreachable(`no measured uid for ${base}`);
    expect(user).toBe(`${measured}:${measured}`);
  });

  test('chown, USER and the pod security context agree on uid, gid and fsGroup', () => {
    const { user, chown } = runtime();
    const values = Bun.YAML.parse(fileAt('docker/helm/values.yaml')) as {
      podSecurityContext?: Record<string, unknown>;
    };
    const [uid, gid] = user.split(':').map(Number);
    expect(chown).toBe(user);
    expect(values.podSecurityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: uid,
      runAsGroup: gid,
      fsGroup: gid,
    });
  });
});
