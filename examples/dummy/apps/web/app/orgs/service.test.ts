// The orgs service below its actions: whose org every call acts in, the refusals that fire before
// a row is read or written, and what an invite inherits from the person who sent it.
import { memberId, orgId } from '@postly/domain';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import { orgsService } from './service';

type Orgs = ReturnType<typeof orgsService>;

/** The service as `ctx.orgs` is built for one request, and the request it runs inside. */
const as = <T>(ctx: Ctx, call: (orgs: Orgs) => Promise<T>): Promise<T> =>
  runWithContext(ctx, () => call(orgsService(ctx)));

/** Signed in, and a member of nothing: no org, so no membership role to act under. */
const stranger = ctxOf({ actor: userActor({ id: 'nobody', roles: ['owner'] }) });

unitTest('every call that acts as a member refuses an actor who is not one', async () => {
  const calls: readonly ((orgs: Orgs) => Promise<unknown>)[] = [
    (orgs) => orgs.invite({ email: 'new@acme.test', role: 'reader' }),
    (orgs) => orgs.upgrade('team'),
    (orgs) => orgs.savePreferences({ theme: 'dark' }),
    (orgs) => orgs.me(),
    (orgs) => orgs.memberById(memberId('7c9e6679-7425-40de-944b-e07fc1f90ae7')),
    (orgs) => orgs.avatarUrl(),
  ];
  for (const call of calls) {
    const refused = await as(stranger, call).catch((error: unknown) => error);
    expect(refused).toBeUltimateError('X_ORG_NOT_A_MEMBER');
  }
});

unitTest(
  'an org nobody holds, or a member another org holds, is not found',
  async ({ seed, actorFor }) => {
    const { ada, mara } = await seed('dev').pick({ ada: 'member:ada', mara: 'member:mara' });
    const ctx = ctxOf({ actor: actorFor(ada) });
    const absent = orgId('00000000-0000-4000-8000-0000000000ff');
    await expect(as(ctx, (orgs) => orgs.byId(absent))).rejects.toBeUltimateError('X_ORG_NOT_FOUND');
    // Mara is Tinta's: read from Acme, her id is no member at all.
    const theirs = as(ctx, (orgs) => orgs.memberById(memberId(mara.id)));
    await expect(theirs).rejects.toBeUltimateError('X_ORG_NOT_FOUND');
  },
);

unitTest(
  'an org reads with its seats, and me is the acting member’s own row',
  async ({ seed, actorFor }) => {
    const { ada } = await seed('dev').pick({ ada: 'member:ada' });
    const ctx = ctxOf({ actor: actorFor(ada) });
    const org = await as(ctx, (orgs) => orgs.byId(orgId(String(ada.orgId))));
    expect(org.planCode).toBe('team');
    expect(org.seats).toBe(25);
    expect(org.seatsUsed).toBe(3);
    expect((await as(ctx, (orgs) => orgs.me())).id).toBe(ada.id);
    expect((await as(ctx, (orgs) => orgs.memberById(memberId(ada.id)))).email).toBe(ada.email);
  },
);

unitTest(
  'an invite inherits the inviter’s zone and locale unless it names its own',
  async ({ seed, actorFor }) => {
    const { ada } = await seed('dev').pick({ ada: 'member:ada' });
    const ctx = ctxOf({ actor: actorFor(ada) });
    const plain = await as(ctx, (orgs) => orgs.invite({ email: 'lin@acme.test', role: 'reader' }));
    expect([plain.tz, plain.locale, plain.name]).toEqual(['America/New_York', 'en', 'lin']);
    const own = await as(ctx, (orgs) =>
      orgs.invite({ email: 'sol@acme.test', role: 'author', tz: 'Asia/Tokyo', locale: 'es' }),
    );
    expect([own.tz, own.locale, own.orgId]).toEqual(['Asia/Tokyo', 'es', ada.orgId]);
  },
);

unitTest('a full plan refuses the invite before any row is written', async ({ seed, actorFor }) => {
  // Tinta is on `free`: three seats, two taken.
  const { mara } = await seed('dev').pick({ mara: 'member:mara' });
  const ctx = ctxOf({ actor: actorFor(mara) });
  await as(ctx, (orgs) => orgs.invite({ email: 'third@tinta.test', role: 'reader' }));
  const fourth = as(ctx, (orgs) => orgs.invite({ email: 'fourth@tinta.test', role: 'reader' }));
  await expect(fourth).rejects.toBeUltimateError('X_BILLING_SEATS_EXCEEDED');
  expect((await as(ctx, (orgs) => orgs.byId(orgId(String(mara.orgId))))).seatsUsed).toBe(3);
});
