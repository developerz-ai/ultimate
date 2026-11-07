// What `x exercise` cannot guess about Postly: who an actor is (a `members` row), the input the
// minimal draw plus seeded ids cannot reach, and why a primitive cannot run in the pass at all.
// Each entry is the value a `.contract({ exercise })` takes, so a test and the pass share a shape.

import { members } from '@postly/db';
import { type SoftAuthenticator, softAuthenticator } from '@ultimat3/auth/soft-authenticator';
import { assert, useContext, userActor } from '@ultimat3/core';
import { defineExercise } from '@ultimat3/testing';

/** Re-homed by the pass into each primitive's own tenant, and bound to a seeded `owner` row. */
const owner = userActor({ id: 'owner', roles: ['owner'] });
const author = userActor({ id: 'author', roles: ['author'] });

/** `x exercise` boots no runtime service a server's boot installs; each of these needs one. */
const NO_STORAGE = 'x exercise installs no storage disk, and this reads or writes one';
const NO_PUSH =
  'x exercise installs no push transport (the VAPID pair is sealed, `x vapid create`)';
const NO_GATEWAY = 'calls a real LLM: x exercise installs no AI gateway';
/**
 * The passkey ceremonies sign what the SERVER issued to one actor, which no draw can forge: each
 * input is computed from the pass's own state, inside the request the call runs in — so the actor
 * read here is the seated one the call acts as. Postly's passkeys are keyed by the acting member's
 * id (`app/auth/passkeys.ts`), and a seeded member has no `x_users` row yet: linked here, once.
 * The app modules load on first use: the pass has installed its database by then.
 */
const actingId = (): string => useContext().actor.id;

/** Postly's passkeys, and the one origin a browser would sign for. */
async function relyingParty() {
  const { auth } = await import('./app/auth/login');
  const origin = auth.passkeys?.origins[0];
  assert(
    origin !== undefined,
    'postlyAuth() declares no passkeys',
    'passkeys: postlyRelyingParty(seams.origin)   # in app/auth/login.ts',
  );
  return { auth, origin, passkeys: (await import('./app/auth/passkeys')).passkeys };
}

/** `relyingParty()`, with `userId` linked to an `x_users` row first. */
async function linkedUser(userId: string) {
  const party = await relyingParty();
  const { adapter, clock } = party.auth;
  if ((await adapter.findUserById(userId)) === null) {
    await adapter.createUser({
      id: userId,
      email: `${userId}@exercise.test`,
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: clock.now(),
    });
  }
  return party;
}

/** A fresh software passkey registered onto `userId` through Postly's own `passkeyLogin`. */
async function enrolled(userId: string): Promise<SoftAuthenticator> {
  const { origin, passkeys } = await linkedUser(userId);
  const device = await softAuthenticator({ origin });
  const options = await passkeys.login.registerOptions({ userId });
  await passkeys.login.register({ userId, response: await device.create(options) });
  return device;
}

export const exercise = defineExercise(
  {
    // A draft moves to `scheduled`; the draw's `to: draft` is a move the machine refuses.
    movePostStatus: {
      actor: author,
      input: (drawn) => ({ ...drawn, to: 'scheduled' }),
    },
    // A slug is unique across EVERY org (`post_slug_unique`) and the draw's title is one constant,
    // so each tenant's call — the pass's, then the scale sweep's two — names its own, by its org.
    createPost: {
      actor: author,
      input: (drawn) => ({ ...drawn, slug: `exercise-${String(drawn['orgId'])}` }),
    },
    // `budget` is text the visitor typed, read in `locale` (`typedBudget`): a drawn string is
    // mostly no amount at all, a 422 the form shows. Digits alone read the same in every locale.
    contactSales: { actor: null, input: (drawn) => ({ ...drawn, budget: '1200' }) },
    // `free` is every seeded org's plan, so the draw's `free` -> `free` is not an upgrade.
    upgradePlan: { actor: owner, input: (drawn) => ({ ...drawn, plan: 'business' }) },
    // The worker asserts the date shape the schema leaves a string (`send-digest.ts:28`).
    sendDigest: { actor: null, input: () => ({ runDate: '2026-01-01' }) },
    // The draw's window is one instant, which holds no seeded run: half-open, it is empty, and the
    // tenant proof had none of A's rows to compare. A window around every seeded run proves it;
    // `actor` is what makes the pass read `input` at all, and an owner holds `run:read`.
    runHealth: {
      actor: owner,
      input: (drawn) => ({
        ...drawn,
        since: new Date('2000-01-01T00:00:00.000Z'),
        until: new Date('2100-01-01T00:00:00.000Z'),
      }),
    },
    // The payload is what `verify` read out of the signed bytes; the draw's JSON `null` is not one.
    'billing.events': {
      actor: null,
      input: (drawn) => ({
        ...drawn,
        payload: { id: 'evt_exercise', type: 'invoice.paid', invoice: 'in_exercise' },
      }),
    },

    answerPrompt: { off: 'answers a prompt a live run is waiting on; only runs.sync writes one' },
    cancelRun: { off: 'cancels the queued job behind a run; the seed writes the run row alone' },
    confirmAgentPublish: {
      off: 'approves a pending agent confirmation; only an agent call makes one',
    },
    endSession: { off: 'sets the sign-out cookie on an HTTP response; there is no request here' },
    inviteMember: {
      off: 'the seed fills each org to its plan seat cap; a 4th is refused by design',
    },
    revokeRunKey: { off: 'revokes an x_api_keys row: framework schema, not an entity to seed' },
    'runs.sync': { off: 'queued only by startRun, which writes the runs row its events reference' },
    'posts.published.webhook': { off: 'delivers to a receiver URL: a real call out, sealed' },
    grantAvatarUpload: { off: NO_STORAGE },
    memberAvatar: { off: NO_STORAGE },
    warmAvatar: { off: NO_STORAGE },
    'runs.statement': { off: NO_STORAGE },
    'posts.export': { off: NO_STORAGE },
    'posts.import': { off: NO_STORAGE },
    'posts.imports.purge': { off: NO_STORAGE },
    grantPostsImport: { off: NO_STORAGE },
    signPostsImportPart: { off: NO_STORAGE },
    listPostsImportParts: { off: NO_STORAGE },
    completePostsImport: { off: NO_STORAGE },
    abortPostsImport: { off: NO_STORAGE },
    // Both reach the avatars target or the export sink, a disk; the erase's tables are proved on
    // their own by the subject proof (`subjectProof`), which needs none.
    'members.export': { off: NO_STORAGE },
    'members.erase': { off: NO_STORAGE },
    // A device token is a provider's alphabet the draw does not produce: an iOS one is hex.
    registerDevice: {
      actor: owner,
      input: (drawn) => ({
        ...drawn,
        platform: 'ios',
        token: 'ab'.repeat(32),
        previousToken: undefined,
      }),
    },
    unregisterDevice: {
      actor: owner,
      input: (drawn) => ({ ...drawn, platform: 'ios', token: 'ab'.repeat(32) }),
    },
    subscribePush: { off: NO_PUSH },
    unsubscribePush: { off: NO_PUSH },
    'post.commented': { off: NO_PUSH },
    passkeyRegisterOptions: {
      actor: author,
      input: async (drawn) => {
        await linkedUser(actingId());
        return drawn;
      },
    },
    registerPasskey: {
      actor: author,
      input: async (drawn) => {
        const userId = actingId();
        const { origin, passkeys } = await linkedUser(userId);
        const options = await passkeys.login.registerOptions({ userId });
        return { ...drawn, response: await (await softAuthenticator({ origin })).create(options) };
      },
    },
    // Usernameless and anonymous: somebody holding a passkey, signing in with it.
    passkeySignIn: {
      actor: null,
      input: async (drawn) => {
        const device = await enrolled(crypto.randomUUID());
        const { passkeys } = await relyingParty();
        return { ...drawn, response: await device.get(await passkeys.login.loginOptions()) };
      },
    },
    erasureApprovalOptions: {
      actor: owner,
      input: async (drawn) => {
        await enrolled(actingId());
        return drawn;
      },
    },
    // Irreversible, so it takes an owner's passkey approval for exactly this org and member; the
    // erase itself is `members.erase`. The other tenant's owner, sent A's approval, is refused.
    requestMemberErasure: {
      actor: owner,
      input: async (drawn) => {
        const userId = actingId();
        const device = await enrolled(userId);
        const { passkeys } = await relyingParty();
        const request = { orgId: String(drawn['orgId']), memberId: String(drawn['memberId']) };
        const options = await passkeys.erasure.options({ userId, input: request });
        return { ...drawn, approval: await device.get(options) };
      },
    },
    keepDraftReview: { off: NO_GATEWAY },
    reviewDraft: { off: NO_GATEWAY },
    summarize: { off: NO_GATEWAY },
    'posts.review': { off: NO_GATEWAY },
    deliverDigest: {
      off: 'its rateLimit is fleet-wide and x exercise installs no shared store (X_RATE_LIMIT_NOT_SHARED)',
    },
  },
  { actor: members },
);
