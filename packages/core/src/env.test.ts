import { describe, expect, test } from 'bun:test';
import { checkEnv, defineEnv, describeEnv, type EnvSchema, maskedEnvValues } from './env';
import { isUltimateError, type UltimateError } from './errors';
import { REDACTED } from './secret';

const schema = {
  DATABASE_URL: { type: 'url', secret: true },
  PORT: { type: 'port', default: 3000 },
  LOG_JSON: { type: 'boolean', default: true },
  REGION: { type: 'enum', values: ['us', 'eu'] },
  SENTRY_DSN: { type: 'url', required: false },
  NATS_URL: { type: 'url', role: 'sync' },
} as const satisfies EnvSchema;

describe('defineEnv', () => {
  test('reports every missing and invalid key in one error', () => {
    let caught: unknown;
    try {
      defineEnv(schema, { env: { PORT: 'not-a-port', REGION: 'qa', ROLE: 'web' } });
    } catch (thrown) {
      caught = thrown;
    }

    expect(isUltimateError(caught)).toBe(true);
    const error = caught as UltimateError;
    expect(error.code).toBe('X_ENV_MISSING');
    // Three problems, one throw — no restart-and-discover loop.
    expect(error.cause).toContain('DATABASE_URL is missing');
    // The SHAPE of the rejected value, never its content: this cause is the boot log line and the
    // `--json` field, and a value baked into a string has no key left to redact. The scaffold's
    // own DATABASE_URL is not `secret: true`, so a malformed one wrote its password here.
    expect(error.cause).toContain(
      'PORT is not an integer port 1-65535 (received a string of 10 characters)',
    );
    expect(error.cause).toContain(
      'REGION is not one of us | eu (received a string of 2 characters)',
    );
    expect(error.cause).not.toContain('not-a-port');
    expect(error.cause).not.toContain('"qa"');
    // The line to add and the file this environment loads — never `x env check`, which printed
    // this same error and this same fix, and never `.env`, which the scaffold does not write.
    expect(error.fix).toBe(
      "echo 'DATABASE_URL=<value>' >> .env.development.local   # DATABASE_URL: an absolute URL; also malformed, where grep -n -e '^PORT=' -e '^REGION=' .env* finds them: PORT (an integer port 1-65535), REGION (one of us | eu)",
    );
    expect(error.fix).not.toContain('x env check');
  });

  test('the fix names the file the environment loads: one line per missing key', () => {
    const two = { A_KEY: { type: 'string' }, B_URL: { type: 'url' } } as const satisfies EnvSchema;
    const fixOf = (env: Record<string, string>): string => {
      try {
        defineEnv(two, { env: { ROLE: 'web', ...env }, redact: false });
      } catch (thrown) {
        return (thrown as UltimateError).fix;
      }
      return expect.unreachable('defineEnv accepted an empty table');
    };
    expect(fixOf({})).toBe(
      "printf '%s\\n' 'A_KEY=<value>' 'B_URL=<value>' >> .env.development.local   # A_KEY: a non-empty string; B_URL: an absolute URL",
    );
    expect(fixOf({ NODE_ENV: 'test' })).toContain('>> .env.test.local');
    // A deploy reads the file `x env init --production` writes, never a per-box development one.
    expect(fixOf({ ULTIMATE_ENV: 'production' })).toContain('>> .env.production ');
    expect(fixOf({ ULTIMATE_ENV: 'staging' })).toContain('>> .env.production ');
  });

  test('only malformed keys: the fix finds each line, in whichever dotenv file sets it', () => {
    let fix = '';
    try {
      defineEnv({ REGION: schema.REGION }, { env: { REGION: 'qa', ROLE: 'web' } });
    } catch (thrown) {
      fix = (thrown as UltimateError).fix;
    }
    expect(fix).toBe(
      "grep -n -e '^REGION=' .env*   # each line to correct: REGION (one of us | eu)",
    );
  });

  test('a key with a declared fix is never given a generated line', () => {
    // A command this build ships: the `errors` step runs every fix line a test cites.
    const STRIPE_FIX =
      'x env check --json   # STRIPE_KEY: the secret key the Stripe dashboard shows';
    let fix = '';
    try {
      defineEnv(
        { STRIPE_KEY: { type: 'string', fix: STRIPE_FIX } },
        { env: { ROLE: 'web' }, redact: false },
      );
    } catch (thrown) {
      fix = (thrown as UltimateError).fix;
    }
    expect(fix).toBe(STRIPE_FIX);
  });

  test('every declared fix survives beside the generated line and beside another declared one', () => {
    const STRIPE_FIX = 'x env check --json   # STRIPE_KEY: the key the Stripe dashboard shows';
    const MAPS_FIX = 'x env check --json   # MAPS_KEY: the key the Maps console shows';
    const declared = {
      STRIPE_KEY: { type: 'string', fix: STRIPE_FIX },
      MAPS_KEY: { type: 'string', fix: MAPS_FIX },
    } as const satisfies EnvSchema;
    const fixOf = (table: EnvSchema): string => {
      try {
        defineEnv(table, { env: { ROLE: 'web' }, redact: false });
      } catch (thrown) {
        return (thrown as UltimateError).fix;
      }
      return expect.unreachable('defineEnv accepted an empty table');
    };
    const both = fixOf(declared);
    expect(both).toStartWith(STRIPE_FIX);
    expect(both).toContain(`MAPS_KEY: ${MAPS_FIX}`);
    const mixed = fixOf({ ...declared, A_KEY: { type: 'string' } });
    expect(mixed).toStartWith("echo 'A_KEY=<value>' >> .env.development.local   # A_KEY:");
    expect(mixed).toContain(`STRIPE_KEY: ${STRIPE_FIX}`);
    expect(mixed).toContain(`MAPS_KEY: ${MAPS_FIX}`);
  });

  test("each issue's fix is a command that finds the line, the key never spliced raw", () => {
    const fixes = checkEnv(
      { REGION: schema.REGION, 'BAD;KEY': { type: 'string' } },
      { env: { REGION: 'qa', ROLE: 'web' } },
    ).issues.map((issue) => issue.fix);
    expect(fixes).toEqual([
      "grep -n -e '^REGION=' .env*   # the line to set to one of us | eu",
      "echo '<KEY>=<value>' >> .env.development.local   # <value>: a non-empty string",
    ]);
  });

  test('coerces types, applies defaults and skips role-scoped keys', () => {
    const env = defineEnv(schema, {
      env: {
        DATABASE_URL: 'postgres://localhost:5432/app',
        REGION: 'eu',
        LOG_JSON: 'off',
        ROLE: 'web',
      },
    });

    expect(env.PORT).toBe(3000);
    expect(env.LOG_JSON).toBe(false);
    expect(env.REGION).toBe('eu');
    expect(env.SENTRY_DSN).toBeUndefined();
    // NATS_URL is only required for role=sync.
    expect(env.NATS_URL).toBeUndefined();
    expect(Object.isFrozen(env)).toBe(true);
  });

  test('a role-scoped key becomes required for that role', () => {
    const report = checkEnv(schema, {
      env: { DATABASE_URL: 'postgres://x/y', REGION: 'us', ROLE: 'sync' },
    });
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.key)).toEqual(['NATS_URL']);
  });

  test('masks secret values in issues and never leaks them', () => {
    const report = checkEnv(schema, { env: { DATABASE_URL: 'not a url', REGION: 'us' } });
    const issue = report.issues.find((candidate) => candidate.key === 'DATABASE_URL');
    expect(issue?.received).toBe('***');
  });

  test('maskedEnvValues is what a report prints — checkEnv().values is not', () => {
    const report = checkEnv(schema, {
      env: { DATABASE_URL: 'postgres://user:pw@host/db', REGION: 'us', ROLE: 'web' },
    });
    // The real value has to be in `values`: `defineEnv()` returns it. Printing goes through the mask.
    expect(report.values['DATABASE_URL']).toBe('postgres://user:pw@host/db');
    const masked = maskedEnvValues(schema, report.values);
    expect(masked['DATABASE_URL']).toBe(REDACTED);
    expect(masked['PORT']).toBe(3000);
    expect(JSON.stringify(masked)).not.toContain('pw@host');
  });

  test('maskedEnvValues masks a credential-named key and a URL password, not only secret:true', () => {
    const loose = {
      DATABASE_URL: { type: 'url' },
      STRIPE_KEY: { type: 'string' },
      S3_ENDPOINT: { type: 'url' },
      REGION: { type: 'string' },
    } as const satisfies EnvSchema;
    const env = {
      DATABASE_URL: 'postgres://app:hunter2@db:5432/app',
      STRIPE_KEY: 'sk_live_abc',
      S3_ENDPOINT: 'https://key:p@ss@s3.internal:9000',
      REGION: 'us',
    };
    const masked = maskedEnvValues(loose, checkEnv(loose, { env }).values);
    expect(masked['DATABASE_URL']).toBe(REDACTED);
    expect(masked['STRIPE_KEY']).toBe(REDACTED);
    expect(masked['S3_ENDPOINT']).toBe(`https://key:${REDACTED}@s3.internal:9000`);
    expect(masked['REGION']).toBe('us');
  });

  test('describeEnv emits declarations only, safe for x.manifest.json', () => {
    const summary = describeEnv(schema);
    expect(summary.find((entry) => entry.key === 'DATABASE_URL')).toEqual({
      key: 'DATABASE_URL',
      type: 'url',
      required: true,
      secret: true,
      hasDefault: false,
      roles: 'all',
      description: undefined,
    });
    expect(summary.find((entry) => entry.key === 'NATS_URL')?.roles).toEqual(['sync']);
  });

  test('a number is a decimal numeral: blank and 0x/0b/0o spellings are invalid', () => {
    const numbers = { PORT: { type: 'port' }, N: { type: 'number' } } as const satisfies EnvSchema;
    for (const [PORT, N] of [
      ['0x1F90', '1'],
      ['8080', ' '],
      ['0b1', '0o17'],
    ] as const) {
      const report = checkEnv(numbers, { env: { PORT, N } });
      expect(report.ok).toBe(false);
    }
    expect(checkEnv(numbers, { env: { PORT: '8080', N: '-1.5e2' } }).values).toEqual({
      PORT: 8080,
      N: -150,
    });
  });

  test('a global or sticky pattern judges every check alike, never a stale lastIndex', () => {
    const tagged = { TAG: { type: 'string', pattern: /^v\d+$/g } } as const satisfies EnvSchema;
    expect(checkEnv(tagged, { env: { TAG: 'v1' } }).ok).toBe(true);
    expect(checkEnv(tagged, { env: { TAG: 'v1' } }).ok).toBe(true);
    const sticky = { TAG: { type: 'string', pattern: /v\d+/y } } as const satisfies EnvSchema;
    expect(checkEnv(sticky, { env: { TAG: 'v1' } }).ok).toBe(true);
    expect(checkEnv(sticky, { env: { TAG: 'v1' } }).ok).toBe(true);
  });

  // One wall-clock round measures the runner, not this function: a CI box running six test shards
  // timed 73ms against a 40ms ceiling for work that costs 0.5ms on a developer machine. Contention
  // only ever ADDS time, so the best of several rounds is the honest sample — under 16-way load the
  // best round stayed within noise of an idle machine while its neighbours in the same run spiked
  // 10x. The first round is discarded because it is still compiling. Boot pays for one check, so the
  // budget is per call, and 50µs is ~20x the real cost — I/O or a quadratic scan misses it by orders.
  const CHECKS_PER_ROUND = 200;
  const BUDGET_US_PER_CHECK = 50;

  test('is fast enough to run at boot', () => {
    const round = (): number => {
      const started = performance.now();
      for (let index = 0; index < CHECKS_PER_ROUND; index += 1) {
        checkEnv(schema, { env: { DATABASE_URL: 'postgres://x/y', REGION: 'us', ROLE: 'web' } });
      }
      return performance.now() - started;
    };
    round();
    const best = Math.min(...Array.from({ length: 5 }, round));
    expect((best / CHECKS_PER_ROUND) * 1000).toBeLessThan(BUDGET_US_PER_CHECK);
  });
});

describe('a key required only in some environments', () => {
  const deployed = {
    PAYMENTS_KEY: {
      type: 'string',
      secret: true,
      required: false,
      requiredIn: ['staging', 'production'],
    },
  } as const satisfies EnvSchema;
  const issuesIn = (env: Record<string, string>): readonly string[] =>
    checkEnv(deployed, { env: { ROLE: 'web', ...env }, redact: false }).issues.map(
      (issue) => issue.key,
    );

  test('unset in development and test: undefined, no issue', () => {
    expect(issuesIn({ ULTIMATE_ENV: 'development' })).toEqual([]);
    expect(issuesIn({ NODE_ENV: 'test' })).toEqual([]);
    const env: { readonly PAYMENTS_KEY: string | undefined } = defineEnv(deployed, {
      env: { ROLE: 'web', ULTIMATE_ENV: 'test' },
      redact: false,
    });
    expect(env.PAYMENTS_KEY).toBeUndefined();
  });

  test('unset in a deploy: missing, as any required key is', () => {
    expect(issuesIn({ ULTIMATE_ENV: 'production' })).toEqual(['PAYMENTS_KEY']);
    expect(issuesIn({ ULTIMATE_ENV: 'staging' })).toEqual(['PAYMENTS_KEY']);
  });

  test('an environment no reader can name fails closed: required', () => {
    expect(issuesIn({ ULTIMATE_ENV: 'prod' })).toEqual(['PAYMENTS_KEY']);
  });

  test('describeEnv names the environments, and only when declared', () => {
    const [summary] = describeEnv({ ...deployed, OTHER: { type: 'string' } });
    expect(summary?.requiredIn).toEqual(['staging', 'production']);
    expect('requiredIn' in (describeEnv({ OTHER: { type: 'string' } })[0] ?? {})).toBe(false);
  });
});
