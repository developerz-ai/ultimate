// Single responsibility: the Bun series is pinned in one place per site, and every site must name
// the same one. Prose in `.github/actions/setup/action.yml` said so and could not enforce it, which
// is how CI sat on 1.3 while every dev box ran 1.4 — a green local `bun run verify` that was not
// evidence of a green CI, and one PR merged red on a bundling difference between the two series.
//
// The tracked apps' own Dockerfiles are sites too, and were outside this test until 2026-08-22:
// six `FROM oven/bun:1.3-alpine` lines, `dummy/social-media-clone/docker/Dockerfile.monorepo`
// among them — the image `.github/workflows/deploy-social-demo.yml` builds on every push to main.
// A series nothing in CI exercises, installing a lockfile written by 1.4 under `--frozen-lockfile`.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { APP_ROOTS } from './boundaries';

const ROOT = join(import.meta.dir, '..');

/** `1.4.x` / `1.4-slim` / `1.4-alpine` all reduce to the series `1.4`. */
const SERIES = /^(\d+\.\d+)/;

const seriesOf = (raw: string): string => {
  const found = SERIES.exec(raw);
  expect(found, `no MAJOR.MINOR series in ${JSON.stringify(raw)}`).not.toBeNull();
  return found?.[1] ?? '';
};

const slurp = async (relative: string): Promise<string> => Bun.file(join(ROOT, relative)).text();

/** Every `bun-version:` value in a workflow or composite action. */
const workflowPins = (yaml: string): string[] =>
  [...yaml.matchAll(/^\s*bun-version:\s*'([^']+)'/gm)].map((match) => match[1] ?? '');

/** Every `FROM oven/bun:<tag>` — anchored, so the historical tags in comments are not pins. */
const imagePins = (dockerfile: string): string[] =>
  [...dockerfile.matchAll(/^FROM oven\/bun:(\S+)/gm)].map((match) => match[1] ?? '');

/**
 * Every Dockerfile the tracked apps ship, DERIVED from `APP_ROOTS` rather than restated: a new
 * application root added to that constant would otherwise leave its images' Bun pin unchecked, with
 * nothing red — the same class of hole this whole file exists for. `Dockerfile*` also matches the
 * `.dockerignore` beside each one, which carries no `FROM` and would read as a site with no pin.
 */
const APP_DOCKERFILES = `${APP_ROOTS}/*/docker/Dockerfile*`;

const appDockerfiles = (): readonly string[] =>
  [...new Bun.Glob(APP_DOCKERFILES).scanSync({ cwd: ROOT })]
    .filter((path) => !path.endsWith('.dockerignore'))
    .sort();

/** `scripts/setup.ts`'s contributor floor, read as source rather than imported: the module installs. */
const requiredBunSeries = (source: string): string => {
  const found = /const REQUIRED_BUN = \[(\d+), (\d+), (\d+)\] as const;/.exec(source);
  expect(found, 'REQUIRED_BUN not found in scripts/setup.ts').not.toBeNull();
  return `${found?.[1]}.${found?.[2]}`;
};

/**
 * The floor the SHIPPED `x` enforces (`packages/cli/src/app-root.ts`). Outside this test until
 * 2026-08-27, and it had drifted a whole minor below every other pin: `1.3.0`, while `x test`
 * emitted `bun test --isolate`, a flag Bun added in 1.3.13. A user on a runtime the CLI declared
 * supported got an unknown-flag failure and an `x doctor` that called the runtime fine.
 */
const cliFloorSeries = (source: string): string => {
  const found = /export const REQUIRED_BUN = '(\d+)\.(\d+)\.(\d+)';/.exec(source);
  expect(found, 'REQUIRED_BUN not found in packages/cli/src/app-root.ts').not.toBeNull();
  return `${found?.[1]}.${found?.[2]}`;
};

/**
 * The floor NPM enforces on anyone installing an `@ultimat3/*` package. The widest site of all and
 * the last one anybody edits — 42 manifests, each free to disagree in silence, because a workspace
 * install never reads its own `engines`. Derived by glob so a new package is covered by existing.
 */
const enginesFloors = async (): Promise<Record<string, string>> => {
  const found: Record<string, string> = {};
  // The ROOT manifest is a site too and lives under none of the workspace roots — it was the one
  // the first draft of this glob missed, which is the same shape of hole as the whole file.
  for (const path of [
    'package.json',
    ...new Bun.Glob('{packages,examples,dummy}/**/package.json').scanSync({ cwd: ROOT }),
  ].sort()) {
    if (path.includes('node_modules')) continue;
    const manifest = (await Bun.file(join(ROOT, path)).json()) as {
      engines?: { bun?: string };
    };
    const declared = manifest.engines?.bun;
    if (declared !== undefined) found[path] = seriesOf(declared.replace(/^[^\d]*/, ''));
  }
  return found;
};

/**
 * `@types/bun` is a pin site, `As of 2026-08-27`, and it was the one nobody counted — a `^1.4.0`
 * caret where every other Bun pin in the repository names an exact series. It decides which Bun API
 * surface `bun run typecheck` believes in, so a range here is the same defect as a range on the
 * runtime, one layer up: the step whose whole job is catching a call the runtime cannot answer,
 * type-checking against a Bun nobody has pinned. Found while trialling the 1.3 series, where the
 * caret held the types a whole minor ahead of the runtime under test.
 *
 * Exact, not a range, for the reason the pinning rule already gives: a range is a silent upgrade.
 */
const typesFloor = async (): Promise<string> => {
  const manifest = (await Bun.file(join(ROOT, 'package.json')).json()) as {
    devDependencies?: Record<string, string>;
  };
  const declared = manifest.devDependencies?.['@types/bun'];
  expect(declared, '@types/bun is not declared in the root manifest').toBeDefined();
  expect(declared, '@types/bun must be pinned exactly — a range re-opens the skew').toMatch(
    /^\d+\.\d+\.\d+$/,
  );
  return seriesOf(declared ?? '');
};

describe('the Bun series is pinned once, in agreement', () => {
  test('CI, the release job, both images and the contributor floor name one series', async () => {
    const setupAction = await slurp('.github/actions/setup/action.yml');
    const release = await slurp('.github/workflows/release.yml');
    const frameworkImage = await slurp('docker/Dockerfile');
    const appImage = await slurp('packages/cli/src/templates/scaffold-container.ts');
    const setupScript = await slurp('scripts/setup.ts');
    const cliFloor = cliFloorSeries(await slurp('packages/cli/src/app-root.ts'));
    const typesSeries = await typesFloor();
    const engines = await enginesFloors();
    // A glob matching nothing would agree with every other pin.
    expect(Object.keys(engines).length).toBeGreaterThanOrEqual(42);

    const ciPins = workflowPins(setupAction);
    const releasePins = workflowPins(release);
    const frameworkTags = imagePins(frameworkImage);
    const appTags = imagePins(appImage);

    // Each site must actually HAVE a pin — an empty list would otherwise agree with everything.
    expect(ciPins).toHaveLength(1);
    expect(releasePins).toHaveLength(1);
    expect(frameworkTags).toHaveLength(3);
    expect(appTags).toHaveLength(2);

    const tracked: Record<string, readonly string[]> = {};
    for (const path of appDockerfiles()) tracked[path] = imagePins(await slurp(path)).map(seriesOf);
    // Three Dockerfiles across the two apps, and a glob matching none would agree with everything.
    expect(Object.keys(tracked).length).toBeGreaterThanOrEqual(3);
    for (const [path, series] of Object.entries(tracked)) {
      expect(series.length, `${path} pins no oven/bun image`).toBeGreaterThan(0);
    }

    const found = {
      ci: seriesOf(ciPins[0] ?? ''),
      release: seriesOf(releasePins[0] ?? ''),
      frameworkImage: frameworkTags.map(seriesOf),
      appImage: appTags.map(seriesOf),
      trackedApps: tracked,
      contributorFloor: requiredBunSeries(setupScript),
      cliFloor,
      typesSeries,
      engines,
    };

    const every = [
      found.ci,
      found.release,
      ...found.frameworkImage,
      ...found.appImage,
      ...Object.values(tracked).flat(),
      found.contributorFloor,
      found.cliFloor,
      found.typesSeries,
      ...Object.values(engines),
    ];
    expect(
      new Set(every).size,
      `the Bun series disagrees across pins: ${JSON.stringify(found)}`,
    ).toBe(1);
  });

  // A series (`1.4.x`) or an exact patch (`1.4.0`); never `latest`, never a bare major. The exact
  // form joined on 2026-09-05: `1.4.x` admitted Bun 1.4.2 the morning it was published, and its
  // bundler retains more of a re-export barrel than 1.4.0's — `packages/ui/src/barrel-bytes.test.ts`
  // fails on `main` under it with nothing changed. A patch that changes what ships to a browser is
  // a change this repository measures, so the pin may name the patch somebody measured.
  test('the pins are a series or an exact patch, never `latest` — nothing lands unannounced', async () => {
    const setupAction = await slurp('.github/actions/setup/action.yml');
    const release = await slurp('.github/workflows/release.yml');

    for (const pin of [...workflowPins(setupAction), ...workflowPins(release)]) {
      expect(pin).toMatch(/^\d+\.\d+\.(?:x|\d+)$/);
    }
  });

  test('every `oven/bun` image tag carries an explicit series, never `latest`', async () => {
    const frameworkImage = await slurp('docker/Dockerfile');
    const appImage = await slurp('packages/cli/src/templates/scaffold-container.ts');
    const tracked: string[] = [];
    for (const path of appDockerfiles()) tracked.push(...imagePins(await slurp(path)));

    for (const tag of [...imagePins(frameworkImage), ...imagePins(appImage), ...tracked]) {
      expect(tag).toMatch(/^\d+\.\d+-(slim|alpine)$/);
    }
  });

  test('the image the demo DEPLOYS is one of the files this test reads', () => {
    // `.github/workflows/deploy-social-demo.yml` builds this file on every push to main, and it
    // was the furthest thing from CI's reach: nothing exercised the series it names.
    expect(appDockerfiles()).toContain('dummy/social-media-clone/docker/Dockerfile.monorepo');
  });
});
