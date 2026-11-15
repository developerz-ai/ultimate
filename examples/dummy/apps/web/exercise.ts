// What `x exercise` cannot guess about Postly: who an actor is (a `members` row), the input the
// minimal draw plus seeded ids cannot reach, and why a primitive cannot run in the pass at all.
// Each entry is the value a `.contract({ exercise })` takes, so a test and the pass share a shape.

import { memberOf } from '@postly/core';
import { db, members } from '@postly/db';
import { memberId, orgId } from '@postly/domain';
import { type SoftAuthenticator, softAuthenticator } from '@ultimat3/auth/soft-authenticator';
import {
  type Actor,
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

/**
 * The actor a signed-in request carries here: the seated member, with the `member` and `org` facts
 * `app/auth/authenticator.ts` resolves at the request boundary — every `app/` page reads them
 * through `useActor()`. Read inside the load's own request, so the member is the route's tenant's.
 */
async function asMember(seated: Actor | null): Promise<Actor | null> {
  if (seated === null || seated.orgId === undefined) return seated;
  const { postlyActor } = await import('./shared/actor');
  return postlyActor(await useContext().orgs.actingFor(orgId(seated.orgId), memberId(seated.id)));
}

/** A fresh software passkey registered onto `userId` through Postly's own `passkeyLogin`. */
async function enrolled(userId: string): Promise<SoftAuthenticator> {
  const { origin, passkeys } = await linkedUser(userId);
  const device = await softAuthenticator({ origin });
  const options = await passkeys.login.registerOptions({ userId });
  await passkeys.login.register({ userId, response: await device.create(options) });
  return device;
}

/**
 * A post of the acting member's org, for the attachment pair: the draw leaves its optional `id`
 * out, and a bare `id` is bound only when drawn. The actor is `owner`, who may edit any of them.
 */
async function orgPostId(): Promise<string> {
  const orgId = memberOf(useContext().actor)?.orgId ?? 'no-member';
  const [post] = await db.posts.where({ orgId }).limit(1).all();
  assert(
    post !== undefined,
    `the exercise seed wrote no post in org ${orgId}`,
    "edit apps/web/exercise.ts — bind requestPostAttachment and confirmPostAttachment { off: '<why>' }",
  );
  return post.id;
}

/**
 * The acting member's avatar, attached through Postly's own step: what `memberAvatar` signs a URL
 * for, at a size its render width is cut from — so the call writes that variant, as the first
 * render after an upload does.
 */
async function attachedAvatar(): Promise<void> {
  const member = memberOf(useContext().actor);
  assert(
    member !== null,
    'the exercise actor is no Postly member',
    'edit apps/web/exercise.ts — memberAvatar: { actor: owner }',
  );
  const { attachAvatar } = await import('./app/orgs/avatar-attach');
  const key = pendingKey(member.orgId, `${crypto.randomUUID()}.png`);
  await disk().put(key, encodeImage(blankRaster(192, 192)), { contentType: 'image/png' });
  await attachAvatar({ orgId: member.orgId, memberId: member.memberId, key });
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
      empty: 'answers the verified event as its result: Postly keeps no billing state to write',
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

    // The draw's `orgId` is the meter's `null` — counted for no org, nobody to tell — so the org's
    // half, the `quotaAlert` it enqueues, never ran: a warning for a seeded org reaches it.
    postsQuotaWarning: {
      input: async (drawn) => {
        const [org] = await db.orgs.limit(1).all();
        return { ...drawn, orgId: org?.id ?? null };
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
    'contact.support-inbox': {
      off: 'reads the message from Resend’s API: a real call out, sealed',
    },
    // The draw's `sample` type and filename are refused by the upload policy before it signs.
    grantAvatarUpload: {
      empty: 'signs a PUT URL for a pending/ key: nothing is stored until the browser sends it',
      input: (drawn) => ({ ...drawn, filename: 'me.png', contentType: 'image/png', size: 1024 }),
    },
    grantPostsImport: {
      input: (drawn) => ({ ...drawn, filename: 'p.csv', contentType: 'text/csv', size: 1024 }),
    },
    // The variant the URL is for is made and kept on the first ask: a member who has an avatar.
    memberAvatar: {
      input: async (drawn) => {
        await attachedAvatar();
        return drawn;
      },
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
    requestPostAttachment: {
      actor: owner,
      input: async (drawn) => ({
        ...drawn,
        filename: 'chart.png',
        contentType: 'image/png',
        size: 1024,
        id: await orgPostId(),
      }),
    },
    // What the grant's URL would have received, as `attachAvatar`'s: a real PNG under `pending/`.
    confirmPostAttachment: {
      actor: owner,
      input: async (drawn) => {
        const orgId = memberOf(useContext().actor)?.orgId ?? 'no-member';
        const key = pendingKey(orgId, `${crypto.randomUUID()}.png`);
        await disk().put(key, encodeImage(blankRaster(8, 8)), { contentType: 'image/png' });
        return { ...drawn, key, id: await orgPostId() };
      },
    },
    // A key the job checks is inside the org it runs for, holding a real image to decode.
    warmAvatar: {
      input: async (drawn) => {
        const key = `org/${String(drawn['orgId'])}/member/exercise/avatar/a.png`;
        // As wide as the narrowest width the job warms: a smaller source is skipped, never upscaled.
        await disk().put(key, encodeImage(blankRaster(48, 48)), { contentType: 'image/png' });
        return { ...drawn, key };
      },
    },
    // The session calls act on a session grantPostsImport opened, which no draw names.
    signPostsImportPart: {
      empty: 'signs one part URL for an open session: the part lands when the client PUTs it',
      input: async (drawn) => ({ ...drawn, ...(await importSession(drawn)), partNumber: 1 }),
    },
    listPostsImportParts: {
      empty: 'lists the parts already on the disk: a storage read, no row and no write',
      input: async (drawn) => ({ ...drawn, ...(await importSession(drawn)) }),
    },
    abortPostsImport: { input: async (drawn) => ({ ...drawn, ...(await importSession(drawn)) }) },
    completePostsImport: {
      input: async (drawn) => {
        const session = await importSession(drawn, { sent: true });
        return { ...drawn, ...session, parts: [{ partNumber: 1 }] };
      },
    },
    // The file the import reads is the CSV `posts.export` writes, one post of it: authored by a
    // member of the org it restores into, its slug its own (`post_slug_unique` spans every org).
    'posts.import': {
      actor: owner,
      input: async (drawn) => {
        const orgId = String(drawn['orgId']);
        const importId = crypto.randomUUID();
        const key = `org/${orgId}/imports/posts/${importId}/posts.csv`;
        // The seated owner, a member of the org the job restores into: the import's author.
        const author = memberOf(useContext().actor);
        assert(
          author !== null && author.orgId === orgId,
          `the exercise owner is no member of org ${orgId}`,
          "edit apps/web/exercise.ts — 'posts.import': { off: '<why>' }",
        );
        const row = `${crypto.randomUUID()},imported-${importId},Imported,draft,0,,2026-01-01T00:00:00.000Z\n`;
        const file = new Uint8Array([...CSV_HEADER, ...new TextEncoder().encode(row)]);
        await disk().put(key, file, { contentType: 'text/csv' });
        return { ...drawn, orgId, importId, authorId: author.memberId, key };
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
    // Postly has no tracker: the issue is one structured log line an operator's alerting reads.
    openErrorIssue: { empty: 'logs the new error group for alerting: no row, mail or object' },
    'posts.imports.purge': {
      empty:
        'deletes import files a week old: the pass wrote its files now, and a put cannot age one',
    },
    keepDraftReview: { off: NO_GATEWAY },
    reviewDraft: { off: NO_GATEWAY },
    summarize: { off: NO_GATEWAY },
    'posts.review': { off: NO_GATEWAY },
    printPost: { off: NO_BROWSER },
  },
  {
    actor: members,
    // Every `app/` page reads the member it renders for: the facts the authenticator resolves.
    routes: {
      '/posts/:id': { actor: asMember },
      '/posts/board': { actor: asMember },
      '/posts/new': {
        actor: asMember,
        empty: 'the editor reads only the actor and the last refused submission: no row',
      },
      '/runs': { actor: asMember },
      '/runs/health': { actor: asMember },
    },
  },
);
