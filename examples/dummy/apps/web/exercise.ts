// What `x exercise` cannot guess about Postly: who an actor is (a `members` row), the input the
// minimal draw plus seeded ids cannot reach, and why a primitive cannot run in the pass at all.
// Each entry is the value a `.contract({ exercise })` takes, so a test and the pass share a shape.

import { memberOf } from '@postly/core';
import { members } from '@postly/db';
import { type SoftAuthenticator, softAuthenticator } from '@ultimat3/auth/soft-authenticator';
import {
  assert,
  blankRaster,
  encodeImage,
  systemClock,
  useContext,
  userActor,
} from '@ultimat3/core';
import { acceptSignedPart, disk, grantMultipart, pendingKey, signPart } from '@ultimat3/storage';
import { defineExercise } from '@ultimat3/testing';

/** Re-homed by the pass into each primitive's own tenant, and bound to a seeded `owner` row. */
const owner = userActor({ id: 'owner', roles: ['owner'] });
const author = userActor({ id: 'author', roles: ['author'] });

/** The one service a server's boot installs that `x exercise` cannot: a real model behind `llm()`. */
const NO_GATEWAY = 'calls a real LLM: x exercise installs no AI gateway';

/** `pdf()` prints through Chrome over CDP, which the pass neither launches nor fakes. */
const NO_BROWSER = 'prints through Chrome: x exercise launches no browser';

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

/** The one file `posts.import` reads, as `posts.export` writes its first line. */
const CSV_HEADER = new TextEncoder().encode(
  'id,slug,title,status,likeCount,publishedAt,createdAt\n',
);

/**
 * An upload session `grantPostsImport` would open for the drawn org, through storage's own calls
 * on the pass's disk — with its one part already sent when the call completes one.
 */
async function importSession(
  drawn: Readonly<Record<string, unknown>>,
  options: { readonly sent?: boolean } = {},
) {
  const { postsImportPolicy } = await import('./app/posts/import-upload');
  const orgId = String(drawn['orgId']);
  const policy = postsImportPolicy;
  const importId = crypto.randomUUID();
  const grant = await grantMultipart({
    disk: disk(),
    orgId,
    request: { filename: 'posts.csv', contentType: 'text/csv', size: CSV_HEADER.byteLength },
    policy,
    uploadId: () => importId,
    clock: systemClock,
  });
  const session = { orgId, key: grant.key, uploadId: grant.uploadId };
  if (options.sent === true) {
    const size = CSV_HEADER.byteLength;
    const url = await signPart({ disk: disk(), ...session, partNumber: 1, size, policy });
    await acceptSignedPart({ url, disk: disk(), orgId, bytes: CSV_HEADER });
  }
  return { ...session, size: CSV_HEADER.byteLength };
}

/** Unpadded base64url, the alphabet a subscription's keys are spelled in. */
const base64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/** What `PushSubscription.toJSON()` carries for a Chromium browser, with a real ECDH key. */
async function browserSubscription() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    expirationTime: null,
    keys: {
      p256dh: base64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
      auth: base64url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
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

    // A posting nets to zero per currency, which no schema can say and a draw never does: one
    // charge, cash in and revenue out, keyed per org so each tenant's pass posts its own.
    'billing.post-charge': {
      actor: null,
      input: (drawn) => ({
        ...drawn,
        key: `ch_exercise_${String(drawn['orgId'])}`,
        entries: [
          { account: 'cash', amount: { minor: 1900, currency: 'USD' } },
          { account: 'revenue', amount: { minor: -1900, currency: 'USD' } },
        ],
      }),
    },

    // The meter's period is a UTC day, its bounds ISO instants the draw does not produce: TODAY's,
    // on the pass's clock, because `quota_alerts` has partitions for this month and three ahead.
    quotaAlert: {
      input: (drawn) => {
        const day = Math.floor(systemClock.now().getTime() / 86_400_000) * 86_400_000;
        return {
          ...drawn,
          periodStart: new Date(day).toISOString(),
          resetsAt: new Date(day + 86_400_000).toISOString(),
        };
      },
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
    // The draw's `sample` type and filename are refused by the upload policy before it signs.
    grantAvatarUpload: {
      input: (drawn) => ({ ...drawn, filename: 'me.png', contentType: 'image/png', size: 1024 }),
    },
    grantPostsImport: {
      input: (drawn) => ({ ...drawn, filename: 'p.csv', contentType: 'text/csv', size: 1024 }),
    },
    // What the grant's URL would have received: a real PNG under the ACTING member's org's
    // `pending/`, the one place `promoteAttachment` takes an upload from.
    attachAvatar: {
      input: async (drawn) => {
        const orgId = memberOf(useContext().actor)?.orgId ?? 'no-member';
        const key = pendingKey(orgId, `${crypto.randomUUID()}.png`);
        await disk().put(key, encodeImage(blankRaster(8, 8)), { contentType: 'image/png' });
        return { ...drawn, key };
      },
    },
    // A key the job checks is inside the org it runs for, holding a real image to decode.
    warmAvatar: {
      input: async (drawn) => {
        const key = `org/${String(drawn['orgId'])}/member/exercise/avatar/a.png`;
        await disk().put(key, encodeImage(blankRaster(8, 8)), { contentType: 'image/png' });
        return { ...drawn, key };
      },
    },
    // The session calls act on a session grantPostsImport opened, which no draw names.
    signPostsImportPart: {
      input: async (drawn) => ({ ...drawn, ...(await importSession(drawn)), partNumber: 1 }),
    },
    listPostsImportParts: {
      input: async (drawn) => ({ ...drawn, ...(await importSession(drawn)) }),
    },
    abortPostsImport: { input: async (drawn) => ({ ...drawn, ...(await importSession(drawn)) }) },
    completePostsImport: {
      input: async (drawn) => {
        const session = await importSession(drawn, { sent: true });
        return { ...drawn, ...session, parts: [{ partNumber: 1 }] };
      },
    },
    // The file the import reads is the CSV `posts.export` writes; header only, it restores none.
    'posts.import': {
      input: async (drawn) => {
        const orgId = String(drawn['orgId']);
        const importId = crypto.randomUUID();
        const key = `org/${orgId}/imports/posts/${importId}/posts.csv`;
        await disk().put(key, CSV_HEADER, { contentType: 'text/csv' });
        return { ...drawn, orgId, importId, key };
      },
    },
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
    // A browser's subscription: a push service's URL and a real P-256 key, as the device makes.
    subscribePush: { input: async (drawn) => ({ ...drawn, ...(await browserSubscription()) }) },
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
    printPost: { off: NO_BROWSER },
  },
  { actor: members },
);
