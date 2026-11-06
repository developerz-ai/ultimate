/**
 * e2e — `x drill` on this app, as an operator runs it: the web and worker roles as real processes on
 * the compose Postgres, the web role SIGTERMed under load, and every request it answered a 2xx. And
 * the refusal this app earns honestly: it declares no redis cache tier, so `redis-down` would fault a
 * service it never dials — refused with `X_DRILL_SERVICE_MISSING`, never run green on nothing.
 * Needs `TEST_DATABASE_URL` (`set -a; . docker/test-services.env; set +a`); skipped without it.
 */

import { describe, expect, test } from 'bun:test';
import { APP_ROOT } from './fixtures/postly';

const services = process.env['TEST_DATABASE_URL'] !== undefined;

/** Boot (migrate, web, worker), a baseline, the signal and the drain: minutes at worst, never more. */
const DRILL_MS = 240_000;

interface DrillOutput {
  readonly ok: boolean;
  readonly findings?: readonly { readonly code: string }[];
  readonly data?: {
    readonly drills: readonly {
      readonly name: string;
      readonly verdict: { readonly ok: boolean; readonly failures: readonly unknown[] };
      readonly evidence: { readonly requests: { readonly ok: number } };
    }[];
  };
}

async function drill(...args: readonly string[]): Promise<DrillOutput> {
  const child = Bun.spawn(['bun', 'run', 'x', '--', 'drill', ...args, '--json'], {
    cwd: APP_ROOT,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return JSON.parse(text) as DrillOutput;
}

describe.skipIf(!services)('x drill on postly', () => {
  test(
    'redis-down is refused: this app declares no redis tier to fault',
    async () => {
      const output = await drill('redis-down');
      expect(output.ok).toBe(false);
      expect(output.findings?.map((finding) => finding.code)).toEqual(['X_DRILL_SERVICE_MISSING']);
    },
    DRILL_MS,
  );

  test(
    'web-sigterm: every request the web role answered under load was a 2xx, and it drained',
    async () => {
      const output = await drill('web-sigterm');
      const [report] = output.data?.drills ?? [];
      expect(report?.verdict.failures).toEqual([]);
      expect(report?.evidence.requests.ok).toBeGreaterThan(0);
      expect(output.ok).toBe(true);
    },
    DRILL_MS,
  );
});
