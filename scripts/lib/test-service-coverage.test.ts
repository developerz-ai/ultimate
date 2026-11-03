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
});

describe('unit · what counts as a read of the environment', () => {
  test('code is a requirement; a comment and a quoted fixture are not', () => {
    const source = `// TEST_REDIS_URL is named in this comment only.
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
});
