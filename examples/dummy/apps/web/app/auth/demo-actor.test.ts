/**
 * The dev viewer: that it resolves, that it carries the member's grants, that the cookie switches
 * it, that it installs in `development` and nowhere else — and that every column declared beside
 * the derived ids still matches the row `packages/db/seeds/dev.ts` writes.
 */

import { actorFact } from '@ultimat3/core';
import { seedId } from '@ultimat3/entity';
import { configuredAuthenticator, resetAuthenticator } from '@ultimat3/http';
import { actorHas } from '@ultimat3/policy';
import { afterEach, describe, expect, test } from '@ultimat3/testing';
import {
  DEFAULT_DEMO_MEMBER,
  DEMO_MEMBER_COOKIE,
  DEMO_MEMBER_NAMES,
  DEMO_VIEWERS,
  demoActorFor,
  demoMemberFrom,
  installDemoAuthenticator,
} from './demo-actor';

const DEVELOPMENT = { NODE_ENV: 'development' } as const;

afterEach(() => {
  resetAuthenticator();
});

describe('the cookie names the viewer', () => {
  test('an unset cookie header is the default member', () => {
    expect(demoMemberFrom(null)).toBe(DEFAULT_DEMO_MEMBER);
  });

  test('a named member wins, even beside other cookies', () => {
    expect(demoMemberFrom(`locale=es; ${DEMO_MEMBER_COOKIE}=mara; tz=UTC`)).toBe('mara');
  });

  // A typo must not un-sign-in the reader: that is the 401 this module exists to remove.
  test('a name nobody declares falls back rather than resolving nobody', () => {
    expect(demoMemberFrom(`${DEMO_MEMBER_COOKIE}=nobody`)).toBe(DEFAULT_DEMO_MEMBER);
  });
});

describe('the viewer is a Postly actor, not a literal', () => {
  test('the member and org rows ride on the actor as facts, which is what app/ renders', () => {
    const actor = demoActorFor('ada');
    expect(actor.kind).toBe('user');
    expect(actor.id).toBe(DEMO_VIEWERS.ada.member.id);
    expect(actor.orgId).toBe(DEMO_VIEWERS.ada.org.id);
    expect(actorFact(actor, 'member')?.name).toBe('Ada Okonjo');
    expect(actorFact(actor, 'org')?.name).toBe('Acme Editorial');
  });

  /** `/settings` is gated on `member:self` and `/feed` on `feed:read`; both must be reachable. */
  test('the roster role expands to the grants the gated routes are declared against', () => {
    const ada = demoActorFor('ada');
    expect(actorHas(ada, 'member:self')).toBe(true);
    expect(actorHas(ada, 'feed:read')).toBe(true);
    expect(actorHas(ada, 'post:publish')).toBe(true);
  });

  test('the reader holds the read grants and none of the write ones', () => {
    const kenji = demoActorFor('kenji');
    expect(actorHas(kenji, 'member:self')).toBe(true);
    expect(actorHas(kenji, 'post:publish')).toBe(false);
    expect(actorHas(kenji, 'org:invite')).toBe(false);
  });

  test('the second viewer is the second tenant, so a cross-org read cannot pass unnoticed', () => {
    expect(demoActorFor('mara').orgId).not.toBe(demoActorFor('ada').orgId);
  });
});

describe('installation is development-only', () => {
  test('development configures the app authenticator', () => {
    expect(installDemoAuthenticator(DEVELOPMENT)).toBe(true);
    expect(configuredAuthenticator()).toBeDefined();
  });

  // `bun test` runs as NODE_ENV=test, and a viewer arriving from a cookie there would decide which
  // member a test is about — every fixture mints its own actor.
  test('test and production configure nothing', () => {
    expect(installDemoAuthenticator({ NODE_ENV: 'test' })).toBe(false);
    expect(installDemoAuthenticator({ ULTIMATE_ENV: 'production' })).toBe(false);
    expect(installDemoAuthenticator({ ULTIMATE_ENV: 'staging' })).toBe(false);
    expect(configuredAuthenticator()).toBeUndefined();
  });

  /**
   * The module-scope call, which is the whole fix: a `configureAuthenticator()` nobody runs is the
   * 401 this file exists to remove, and it cannot be observed in-process because this suite is
   * `NODE_ENV=test` on purpose. So a child process imports the module as `x dev`'s boot scan does.
   */
  test('importing the module in development installs the hook, with nobody calling anything', async () => {
    const child = Bun.spawn(
      [
        'bun',
        '-e',
        `await import(${JSON.stringify(`${import.meta.dir}/demo-actor.ts`)});
         const { configuredAuthenticator } = await import('@ultimat3/http');
         console.log('VERDICT', configuredAuthenticator() === undefined ? 'none' : 'installed');`,
      ],
      {
        cwd: import.meta.dir,
        env: { ...process.env, NODE_ENV: 'development', ULTIMATE_ENV: 'development' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(out).toContain('VERDICT installed');
  });

  test('the installed hook answers the cookie the request carries', async () => {
    installDemoAuthenticator(DEVELOPMENT);
    const authenticate = configuredAuthenticator();
    if (authenticate === undefined) expect.unreachable('development must install an authenticator');
    const request = { header: () => `${DEMO_MEMBER_COOKIE}=mara` };
    // Both arguments are structural to the hook; only `header` is read.
    const actor = await authenticate(
      request as unknown as Parameters<typeof authenticate>[0],
      undefined as unknown as Parameters<typeof authenticate>[1],
    );
    expect(actor?.id).toBe(DEMO_VIEWERS.mara.member.id);
  });
});

/**
 * The declared columns against the seed's own rows. Without this the viewer is a second copy of the
 * roster that nothing keeps in step — a name or a zone edited in the seed would render stale in dev
 * and nothing would say so.
 */
describe('every declared column is the seeded row', () => {
  test('the ids are the seed labels, derived rather than pasted', () => {
    for (const name of DEMO_MEMBER_NAMES) {
      expect(DEMO_VIEWERS[name].member.id).toBe(seedId(`member:${name}`));
    }
    expect(DEMO_VIEWERS.ada.org.id).toBe(seedId('org:acme'));
    expect(DEMO_VIEWERS.mara.org.id).toBe(seedId('org:tinta'));
  });

  test('every member column matches the row the seed writes', async ({ seed }) => {
    const rows = await seed('dev').pick({
      ada: 'member:ada',
      kenji: 'member:kenji',
      mara: 'member:mara',
    });
    for (const name of DEMO_MEMBER_NAMES) {
      const declared = DEMO_VIEWERS[name].member;
      const seeded = rows[name];
      expect({ ...declared, id: seeded.id }).toEqual({
        id: seeded.id,
        orgId: seeded.orgId,
        email: seeded.email,
        name: seeded.name,
        role: seeded.role,
        tz: seeded.tz,
        locale: seeded.locale,
        theme: seeded.theme,
        digestOptIn: seeded.digestOptIn,
      });
    }
  });

  test('every org column matches, and seatsUsed is the seeded roster size', async ({ seed }) => {
    const rows = await seed('dev').pick({
      acme: 'org:acme',
      tinta: 'org:tinta',
      ada: 'member:ada',
      bruno: 'member:bruno',
      kenji: 'member:kenji',
      mara: 'member:mara',
      noa: 'member:noa',
    });
    const membersIn = (orgId: unknown): number =>
      (['ada', 'bruno', 'kenji', 'mara', 'noa'] as const).filter(
        (member) => rows[member].orgId === orgId,
      ).length;

    for (const [name, org] of [
      ['acme', DEMO_VIEWERS.ada.org],
      ['tinta', DEMO_VIEWERS.mara.org],
    ] as const) {
      const seeded = rows[name];
      expect(org.slug).toBe(seeded.slug);
      expect(org.name).toBe(seeded.name);
      expect(org.planCode).toBe(seeded.planCode);
      expect(org.billingCurrency).toBe(seeded.billingCurrency);
      expect(org.seatsUsed).toBe(membersIn(seeded.id));
    }
  });
});
