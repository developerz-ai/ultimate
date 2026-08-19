// A test failure has to be as actionable as a runtime failure, and the title is the first line
// of that contract — in the terminal, the dev overlay and `--json`. These tests prove the
// registry actually reflects what TESTING_ERROR_TITLES declares.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import {
  FixtureUnknownError,
  fixtureUnknown,
  hostOf,
  NetworkRaceError,
  NetworkSealedError,
  TESTING_ERROR_CODES,
  TESTING_ERROR_TITLES,
  TestEvalThresholdError,
  TestJobExpectedError,
  TestSchemaExpectedError,
} from './errors';
import { testName } from './test-types';

describe(testName('unit', 'TESTING_ERROR_TITLES'), () => {
  test('has exactly one entry per code in TESTING_ERROR_CODES, and no others', () => {
    expect(Object.keys(TESTING_ERROR_TITLES).sort()).toEqual([...TESTING_ERROR_CODES].sort());
  });

  test('every title is a non-empty string', () => {
    for (const code of TESTING_ERROR_CODES) {
      expect(typeof TESTING_ERROR_TITLES[code]).toBe('string');
      expect(TESTING_ERROR_TITLES[code].length).toBeGreaterThan(0);
    }
  });

  test('every code this package declares is one it owns, so all of them are titled', () => {
    // Nothing here is borrowed: `TESTING_ERROR_CODES` is exactly what `registerErrorCodes()`
    // is handed at import, unconditionally, so a collision surfaces as X_ERROR_CODE_DUPLICATE.
    expect(Object.keys(TESTING_ERROR_TITLES).length).toBe(TESTING_ERROR_CODES.length);
  });
});

describe(testName('unit', 'error code registry'), () => {
  test('every testing code is registered with its declared title', () => {
    for (const code of TESTING_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(TESTING_ERROR_TITLES[code]);
    }
  });

  test('every testing code documents at its own X_* url', () => {
    for (const code of TESTING_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});

describe(testName('unit', 'X_TEST_NETWORK_SEALED names the host to allow'), () => {
  test('the fix line carries the request URL and its host, not a placeholder', () => {
    const error = new NetworkSealedError({
      url: 'https://api.stripe.com/v1/charges',
      method: 'POST',
      allowed: ['localhost'],
    });
    expect(error.code).toBe('X_TEST_NETWORK_SEALED');
    expect(error.cause).toBe(
      'POST https://api.stripe.com/v1/charges was not mocked (allowed hosts: localhost)',
    );
    expect(error.fix).toContain("mockFetch('https://api.stripe.com/v1/charges'");
    expect(error.fix).toContain("allowHost('api.stripe.com')");
  });

  test('an empty allowlist reads "none" — never an empty parenthesis the reader must decode', () => {
    const error = new NetworkSealedError({ url: 'https://x.test/', method: 'GET', allowed: [] });
    expect(error.cause).toContain('(allowed hosts: none)');
  });

  test('a URL the URL parser refuses still yields a fix line — hostOf falls back to the input', () => {
    // The seal catches whatever the app passed to fetch(); a relative or malformed specifier is
    // exactly the case where the reader most needs a message rather than a TypeError from here.
    expect(hostOf('not a url at all')).toBe('not a url at all');
    expect(new NetworkSealedError({ url: '/api/me', method: 'GET', allowed: [] }).fix).toContain(
      "allowHost('/api/me')",
    );
  });
});

describe(testName('unit', 'X_TEST_FIXTURE_UNKNOWN lists what IS registered'), () => {
  test('with fixtures registered, the cause names them so a typo is visible', () => {
    const error = new FixtureUnknownError({ name: 'actorr', registered: ['actor', 'seed'] });
    expect(error.code).toBe('X_TEST_FIXTURE_UNKNOWN');
    expect(error.cause).toBe('test requested fixture "actorr"; registered: actor, seed');
    expect(error.fix).toBe(
      'register it at test setup: defineFixtures({ actorr: () => buildIt() })',
    );
  });

  test('with none registered it says so, rather than printing an empty list', () => {
    expect(new FixtureUnknownError({ name: 'actor', registered: [] }).cause).toBe(
      'test requested fixture "actor" but none are registered',
    );
  });

  test('fixtureUnknown() builds the same error the class does', () => {
    const built = fixtureUnknown('actor', ['seed']);
    expect(built).toBeInstanceOf(FixtureUnknownError);
    expect(built.cause).toBe('test requested fixture "actor"; registered: seed');
  });
});

describe(testName('unit', 'the three matcher/eval failures name the call to edit'), () => {
  test('X_TEST_EVAL_THRESHOLD carries the eval name, the threshold and the scores', () => {
    const error = new TestEvalThresholdError({
      name: 'summarise',
      threshold: 0.8,
      detail: 'terse=0.40',
    });
    expect(error.code).toBe('X_TEST_EVAL_THRESHOLD');
    expect(error.cause).toBe('eval "summarise" scored below 0.8: terse=0.40');
    expect(error.fix).toContain('lower the threshold passed to evalTest()');
  });

  test('X_TEST_SCHEMA_EXPECTED names toRejectInput(action.input), the pasteable call', () => {
    const error = new TestSchemaExpectedError();
    expect(error.code).toBe('X_TEST_SCHEMA_EXPECTED');
    expect(error.fix).toContain('toRejectInput(action.input)');
    expect(error.cause).toContain('Standard Schema');
  });

  test('X_TEST_JOB_EXPECTED names the job export, not the handler', () => {
    const error = new TestJobExpectedError();
    expect(error.code).toBe('X_TEST_JOB_EXPECTED');
    expect(error.fix).toContain('toEmitSteps(myJob)');
    expect(error.fix).toContain('not toEmitSteps(myJob.run)');
  });

  test('X_TEST_NETWORK_RACE tells the reader not to unseal mid-request', () => {
    const error = new NetworkRaceError();
    expect(error.code).toBe('X_TEST_NETWORK_RACE');
    expect(error.cause).toBe('sealed network lost its original fetch mid-request');
    expect(error.fix).toContain('do not call unsealNetwork()');
  });
});
