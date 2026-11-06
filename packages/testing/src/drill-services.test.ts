// A drill's services: refused when a URL is unset or the app does not use the faulted service, and
// every service the app does use is required, since its roles would not boot without it.

import { describe, expect, test } from 'bun:test';
import { DrillFailedError } from './drill-errors';
import { drillServices } from './drill-services';
import { drillNamed } from './drills';

const env = {
  TEST_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/postgres',
  TEST_REDIS_URL: 'redis://127.0.0.1:6379',
  TEST_NATS_URL: 'nats://127.0.0.1:4222',
};
const none = { redis: false, nats: undefined };
const drill = (name: string) => drillNamed(name) ?? expect.unreachable();

describe('drillServices', () => {
  test('Postgres alone for an app that declares nothing more', () => {
    expect(drillServices(drill('pg-blackhole'), env, none)).toEqual({
      postgres: env.TEST_DATABASE_URL,
      redis: undefined,
      nats: undefined,
    });
  });

  test('an unset Postgres is refused, never skipped', () => {
    expect(() => drillServices(drill('pg-slow'), {}, none)).toThrow(
      expect.objectContaining({
        code: 'X_DRILL_SERVICE_MISSING',
        meta: { drill: 'pg-slow', gap: 'unset' },
      }),
    );
  });

  test('a drill faulting a service the app does not use is refused with the declaration', () => {
    let thrown: unknown;
    try {
      drillServices(drill('redis-down'), env, none);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUltimateError('X_DRILL_SERVICE_MISSING');
    expect(String(Reflect.get(thrown as object, 'fix'))).toStartWith('x drill --list --json');
    expect(() => drillServices(drill('nats-down'), env, none)).toThrow(/does not use/);
  });

  test('every declared service is required, whichever drill runs', () => {
    const declared = { redis: true, nats: { env: 'BUS_URL' } };
    expect(drillServices(drill('web-sigterm'), env, declared)).toEqual({
      postgres: env.TEST_DATABASE_URL,
      redis: env.TEST_REDIS_URL,
      nats: { url: env.TEST_NATS_URL, env: 'BUS_URL' },
    });
    const { TEST_REDIS_URL: _gone, ...noRedis } = env;
    expect(() => drillServices(drill('pg-slow'), noRedis, declared)).toThrow(/TEST_REDIS_URL/);
  });
});

describe('DrillFailedError', () => {
  test('names the property, its evidence and the command that replays the drill', () => {
    const error = new DrillFailedError({
      drill: 'pg-blackhole',
      failure: {
        property: 'requests-coded',
        expected: 'every failed request coded',
        observed: '2 uncoded',
      },
    });
    expect(error).toBeUltimateError('X_DRILL_FAILED');
    expect(error.cause).toContain('requests-coded did not hold');
    expect(error.fix).toStartWith('x drill pg-blackhole --json');
  });
});
