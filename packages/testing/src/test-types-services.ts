// What a typed test may declare it needs from a real server, and how that need is answered: the
// `TEST_*_URL` variable `docker/test-services.env` writes for each service. Set, the test runs;
// unset, it is skipped with the service and the command that starts it in its own reported name.

/** The services a test may declare, each under the variable the test services publish it as. */
export const TEST_SERVICE_ENV = {
  postgres: 'TEST_DATABASE_URL',
  redis: 'TEST_REDIS_URL',
  nats: 'TEST_NATS_URL',
} as const;

export type TestService = keyof typeof TEST_SERVICE_ENV;

/**
 * The lines that start every service and point this shell at them — the same two the generated
 * `docker/docker-compose.test.yml` header names, so a skipped test's reason is a paste, not a hunt.
 */
export const TEST_SERVICES_START =
  'docker compose -f docker/docker-compose.test.yml up -d --wait && set -a && . docker/test-services.env && set +a';

type Env = Readonly<Record<string, string | undefined>>;

/** The declared services whose variable is unset or blank in `env`, in declared order. */
export const missingServices = (needs: readonly TestService[], env: Env): readonly TestService[] =>
  needs.filter((service) => (env[TEST_SERVICE_ENV[service]]?.trim() ?? '') === '');

/**
 * The suffix a skipped test's name carries: each missing service, the variable it is read from,
 * and the command that starts them. `undefined` when nothing is missing — the test runs.
 */
export function serviceSkipReason(needs: readonly TestService[], env: Env): string | undefined {
  const missing = missingServices(needs, env);
  if (missing.length === 0) return undefined;
  const named = missing.map((service) => `${service} (${TEST_SERVICE_ENV[service]})`).join(', ');
  return `needs ${named} unset: ${TEST_SERVICES_START}`;
}
