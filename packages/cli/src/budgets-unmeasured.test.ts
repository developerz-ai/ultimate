// A route the build could not weigh because the MEASUREMENT ACTOR was refused: the finding names
// the actor, the refusal and `defineMeasurementActor()` — the one edit that closes it (#675). Every
// other render failure keeps the generic instruction, with the refusal's code in the cause.

import { describe, expect, test } from 'bun:test';
import type { RouteFact } from '@ultimat3/manifest';
import { buildManifest } from '@ultimat3/manifest';
import { checkBudgets } from './budgets';
import type { UnmeasuredRoute } from './static-report';

const manifest = buildManifest({
  app: { name: 'fixture', version: '1.0.0' },
  routes: [{ url: '/console', render: 'ssr', budget: { js: '60kb' } } satisfies RouteFact],
});

const ACTOR = 'service:x-build-measure (roles: none)';

const refused = (code: string, cause: string): UnmeasuredRoute => ({
  path: '/console',
  reason: `${code}: ${cause}`,
  code,
  cause,
  fix: 'a fix written for a request, not for a build',
  actor: ACTOR,
});

const only = (entry: UnmeasuredRoute) => {
  const findings = checkBudgets(manifest, { routes: [] }, [entry]);
  expect(findings).toHaveLength(1);
  return findings[0];
};

describe('unit · a route the measurement actor could not render', () => {
  for (const code of ['X_FORBIDDEN', 'X_UNAUTHENTICATED', 'X_TENANCY_ACTOR_ORG_REQUIRED']) {
    test(`${code} names the actor, the refusal and defineMeasurementActor()`, () => {
      const finding = only(refused(code, 'the policy said no'));
      expect(finding?.code).toBe('X_BUDGET_UNMEASURED');
      expect(finding?.cause).toContain(ACTOR);
      expect(finding?.cause).toContain(code);
      expect(finding?.cause).toContain('the policy said no');
      expect(finding?.fix).toContain('app.config.ts');
      expect(finding?.fix).toContain('defineMeasurementActor(() => userActor({');
      expect(finding?.fix).toContain("orgId: '<");
      expect(finding?.fix).toContain("roles: ['<");
    });
  }

  // Not every refusal is the actor's: a database the build never had is a fact about the build,
  // and an actor edit would not move it. The code still reaches the cause — the reason was only
  // in the report, one command away.
  test('a refusal that is not the actor’s keeps the report instruction, with its code in the cause', () => {
    const finding = only(refused('X_DB_UNAVAILABLE', 'no database'));
    expect(finding?.code).toBe('X_BUDGET_UNMEASURED');
    expect(finding?.cause).toContain('X_DB_UNAVAILABLE: no database');
    expect(finding?.fix).not.toContain('defineMeasurementActor');
    expect(finding?.fix).toContain('x build --target static --json');
  });

  test('a report written before the actor was recorded still names the declaration to edit', () => {
    const { actor: _actor, ...older } = refused('X_FORBIDDEN', 'no');
    const finding = only(older);
    expect(finding?.cause).toContain('the measurement actor');
    expect(finding?.fix).toContain('defineMeasurementActor');
  });
});
