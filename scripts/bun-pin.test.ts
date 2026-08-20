// Single responsibility: the Bun series is pinned in five places, and they must name the same one.
// Prose in `.github/actions/setup/action.yml` said so and could not enforce it, which is how CI sat
// on 1.3 while every dev box ran 1.4 — a green local `bun run verify` that was not evidence of a
// green CI, and one PR merged red on a bundling difference between the two series.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

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

/** `scripts/setup.ts`'s contributor floor, read as source rather than imported: the module installs. */
const requiredBunSeries = (source: string): string => {
  const found = /const REQUIRED_BUN = \[(\d+), (\d+), (\d+)\] as const;/.exec(source);
  expect(found, 'REQUIRED_BUN not found in scripts/setup.ts').not.toBeNull();
  return `${found?.[1]}.${found?.[2]}`;
};

describe('the Bun series is pinned once, in agreement', () => {
  test('CI, the release job, both images and the contributor floor name one series', async () => {
    const setupAction = await slurp('.github/actions/setup/action.yml');
    const release = await slurp('.github/workflows/release.yml');
    const frameworkImage = await slurp('docker/Dockerfile');
    const appImage = await slurp('packages/cli/src/templates/scaffold-container.ts');
    const setupScript = await slurp('scripts/setup.ts');

    const ciPins = workflowPins(setupAction);
    const releasePins = workflowPins(release);
    const frameworkTags = imagePins(frameworkImage);
    const appTags = imagePins(appImage);

    // Each site must actually HAVE a pin — an empty list would otherwise agree with everything.
    expect(ciPins).toHaveLength(1);
    expect(releasePins).toHaveLength(1);
    expect(frameworkTags).toHaveLength(3);
    expect(appTags).toHaveLength(2);

    const found = {
      ci: seriesOf(ciPins[0] ?? ''),
      release: seriesOf(releasePins[0] ?? ''),
      frameworkImage: frameworkTags.map(seriesOf),
      appImage: appTags.map(seriesOf),
      contributorFloor: requiredBunSeries(setupScript),
    };

    const every = [
      found.ci,
      found.release,
      ...found.frameworkImage,
      ...found.appImage,
      found.contributorFloor,
    ];
    expect(
      new Set(every).size,
      `the Bun series disagrees across pins: ${JSON.stringify(found)}`,
    ).toBe(1);
  });

  test('the pins are a series, never `latest` — a major may not land unannounced', async () => {
    const setupAction = await slurp('.github/actions/setup/action.yml');
    const release = await slurp('.github/workflows/release.yml');

    for (const pin of [...workflowPins(setupAction), ...workflowPins(release)]) {
      expect(pin).toMatch(/^\d+\.\d+\.x$/);
    }
  });

  test('every `oven/bun` image tag carries an explicit series, never `latest`', async () => {
    const frameworkImage = await slurp('docker/Dockerfile');
    const appImage = await slurp('packages/cli/src/templates/scaffold-container.ts');

    for (const tag of [...imagePins(frameworkImage), ...imagePins(appImage)]) {
      expect(tag).toMatch(/^\d+\.\d+-(slim|alpine)$/);
    }
  });
});
