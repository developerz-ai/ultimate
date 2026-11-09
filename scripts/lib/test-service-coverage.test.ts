// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures below are SOURCE TEXT — a
// `${…}` in one is the code under test, never an interpolation that went missing.
// The rule that decides whether a CI part supplies a suite's service, over fixture worlds — the
// real tree is `scripts/test-services-shape.test.ts`'s, and this file never reads it.

import { describe, expect, test } from 'bun:test';
import type { ServicePart, ServiceSuite } from './test-service-coverage';
import { requiredServiceUrls, serviceCoverageGaps } from './test-service-coverage';

/** The compose service behind each URL a suite may need. */
const SERVES = new Map([
  ['TEST_DATABASE_URL', 'postgres'],
  ['TEST_REDIS_URL', 'redis'],
]);

/** The part that runs `live`, starts Postgres and exports its URL. */
const LIVE: ServicePart = {
  part: 'live',
  only: ['live'],
  services: ['postgres'],
  urls: ['TEST_DATABASE_URL'],
};

/** The part that runs `live`, starts Redis and exports its URL. */
const WITH_REDIS: ServicePart = {
  part: 'live',
  only: ['live'],
  services: ['postgres', 'redis'],
  urls: ['TEST_DATABASE_URL', 'TEST_REDIS_URL'],
};

/** The part that starts Redis and exports its URL, but runs another step. */
const OTHER_STEP: ServicePart = {
  part: 'e2e',
  only: ['e2e'],
  services: ['postgres', 'redis'],
  urls: ['TEST_DATABASE_URL', 'TEST_REDIS_URL'],
};

/** The part that runs `live` and exports the Redis URL, but starts no Redis. */
const NO_SERVER: ServicePart = {
  part: 'live',
  only: ['live'],
  services: ['postgres'],
  urls: ['TEST_DATABASE_URL', 'TEST_REDIS_URL'],
};

/** The part that runs `live` and starts Redis, but exports no URL for it. */
const NO_URL: ServicePart = {
  part: 'live',
  only: ['live'],
  services: ['postgres', 'redis'],
  urls: ['TEST_DATABASE_URL'],
};

const REDIS_SUITE = 'packages/cache/src/redis.live.test.ts';
const POSTGRES_SUITE = 'packages/db/src/client.live.test.ts';

const suite = (path: string, step: string, required: readonly string[]): ServiceSuite => ({
  path,
  step,
  required,
});

describe('unit · the gap a suite leaves when no part supplies its service', () => {
  test('one gap names the suite and the URL, and a covered suite of the same step names none', () => {
    const gaps = serviceCoverageGaps(
      [
        suite(REDIS_SUITE, 'live', ['TEST_REDIS_URL']),
        suite(POSTGRES_SUITE, 'live', ['TEST_DATABASE_URL']),
      ],
      [LIVE],
      SERVES,
    );

    expect(gaps).toEqual([{ suite: REDIS_SUITE, url: 'TEST_REDIS_URL' }]);
  });

  test('a part that runs the step, starts the service and exports the URL supplies the suite', () => {
    const gaps = serviceCoverageGaps(
      [suite(REDIS_SUITE, 'live', ['TEST_REDIS_URL'])],
      [WITH_REDIS],
      SERVES,
    );

    expect(gaps).toEqual([]);
  });

  test('a part that exports the URL but runs another step leaves the suite unsupplied', () => {
    const gaps = serviceCoverageGaps(
      [suite(REDIS_SUITE, 'live', ['TEST_REDIS_URL'])],
      [OTHER_STEP],
      SERVES,
    );

    expect(gaps).toEqual([{ suite: REDIS_SUITE, url: 'TEST_REDIS_URL' }]);
  });

  test('a part that runs the step and exports the URL but starts no such server leaves it too', () => {
    const gaps = serviceCoverageGaps(
      [suite(REDIS_SUITE, 'live', ['TEST_REDIS_URL'])],
      [NO_SERVER],
      SERVES,
    );

    expect(gaps).toEqual([{ suite: REDIS_SUITE, url: 'TEST_REDIS_URL' }]);
  });

  // The fixture that pins the export alone: this part runs the step AND starts Redis, so the
  // missing URL is the only thing left that can leave the suite unsupplied.
  test('a part that starts the service but exports no URL for it leaves the suite unsupplied', () => {
    const gaps = serviceCoverageGaps(
      [suite(REDIS_SUITE, 'live', ['TEST_REDIS_URL'])],
      [NO_URL],
      SERVES,
    );

    expect(gaps).toEqual([{ suite: REDIS_SUITE, url: 'TEST_REDIS_URL' }]);
  });
});

// `live` is split across runners (`--shard i/n`): a suite lands on ONE shard by its place in the
// sorted file list, which this rule does not compute. So every part running the step must supply
// it — a shard that skipped Redis would leave whichever Redis suite it was dealt unsupplied.
describe('unit · a step split across parts needs every part to supply the service', () => {
  const shard = (part: string, from: ServicePart): ServicePart => ({ ...from, part });

  test('one shard without the server leaves the suite unsupplied, though the other starts it', () => {
    const gaps = serviceCoverageGaps(
      [suite(REDIS_SUITE, 'live', ['TEST_REDIS_URL'])],
      [shard('live-1', WITH_REDIS), shard('live-2', LIVE)],
      SERVES,
    );

    expect(gaps).toEqual([{ suite: REDIS_SUITE, url: 'TEST_REDIS_URL' }]);
  });

  test('every shard supplying it, and a part running another step, leave no gap', () => {
    const gaps = serviceCoverageGaps(
      [suite(REDIS_SUITE, 'live', ['TEST_REDIS_URL'])],
      [shard('live-1', WITH_REDIS), shard('live-2', WITH_REDIS), { ...LIVE, only: ['e2e'] }],
      SERVES,
    );

    expect(gaps).toEqual([]);
  });
});

describe('unit · what counts as a read of the environment', () => {
  test('code is a requirement; a comment and a quoted fixture are not', () => {
    // The comment and the fixture name a URL the code never reads, so counting either one grows
    // the answer and the assertion below turns red.
    const source = `// Bun.env['TEST_NATS_URL'] is named in this comment only.
const url = Bun.env['TEST_REDIS_URL'];
const fixture = \`const other = Bun.env['TEST_NATS_URL'];\`;`;

    expect(requiredServiceUrls(source)).toEqual(['TEST_REDIS_URL']);
  });

  test('the `${…}` of a template is evaluated code, so a read inside it counts', () => {
    const source = "const url = `${Bun.env['TEST_REDIS_URL']}`;";

    expect(requiredServiceUrls(source)).toEqual(['TEST_REDIS_URL']);
  });

  test('the DATABASE_URL of an app is not a service', () => {
    expect(requiredServiceUrls("const url = Bun.env['DATABASE_URL'];")).toEqual([]);
  });

  test('process.env reads the same way, and one name read twice is one requirement', () => {
    const source = `const one = process.env['TEST_DATABASE_URL'];
const two = process.env['TEST_DATABASE_URL'];`;

    expect(requiredServiceUrls(source)).toEqual(['TEST_DATABASE_URL']);
  });

  test('a destructured read is a requirement: the name sits in the pattern', () => {
    const source = `const { TEST_REDIS_URL } = Bun.env;
const { TEST_NATS_URL: nats } = process.env;`;

    expect(requiredServiceUrls(source)).toEqual(['TEST_NATS_URL', 'TEST_REDIS_URL']);
  });

  test('a write is not a requirement: a suite that sets a URL needs no server', () => {
    const source = `Bun.env['TEST_REDIS_URL'] = 'redis://fixture';
Bun.env.TEST_NATS_URL = 'nats://fixture';`;

    expect(requiredServiceUrls(source)).toEqual([]);
  });

  test('a read beside a write is still a requirement', () => {
    const source = `Bun.env['TEST_REDIS_URL'] = 'redis://fixture';
const url = Bun.env['TEST_REDIS_URL'];`;

    expect(requiredServiceUrls(source)).toEqual(['TEST_REDIS_URL']);
  });
});
