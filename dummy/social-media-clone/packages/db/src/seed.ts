// The demo's fixture graph. Deterministic by construction: `id('user:ada')` is a stable UUID v5 of
// the label and every timestamp is a literal, so a bug reproduced locally reproduces in CI and the
// public demo shows the same content on every reset.
//
// The graph is built to exercise the VISIBILITY rules, not to look busy. Every row below exists
// because some rule needs a case: a blocked pair, a pending request in each direction, a
// friends-only post the viewer may not see, a soft-deleted post, two locales, and four IANA zones
// including one southern-hemisphere and one without DST.

import { defineSeed, seedId } from '@ultimat3/entity';
import { driver } from './client';
import {
  blocks,
  comments,
  conversations,
  credentials,
  friendships,
  likes,
  media,
  messages,
  notifications,
  participants,
  posts,
  users,
} from './schema';
import { seededIds } from './seeded-ids';

/**
 * The rows whose presence says "this store holds the demo's fixture graph, and nothing else's".
 *
 * `seedId` is a UUID v5 of the label in the framework's fixed namespace, so these two values are the
 * same on every machine and are not reachable by accident: a database that answers to both of them
 * was seeded by THIS seed. That is what `resetDemo` asks before it deletes anything — it used to ask
 * whether `DATABASE_URL` was set, which stopped meaning "not the demo" the moment the demo got one.
 */
export const DEMO_MARKER_IDS: readonly string[] = [seedId('user:user'), seedId('user:admin')];

/** The two demo logins, said out loud so a reader does not have to infer them from a hash. */
export const DEMO_LOGINS = [
  { handle: 'user', password: 'user', role: 'member' },
  { handle: 'admin', password: 'admin', role: 'admin' },
] as const;

const at = (iso: string): Date => new Date(iso);

export const demo = defineSeed('demo', async ({ insert, id }) => {
  await insert(users, [
    {
      id: id('user:user'),
      handle: 'user',
      email: 'user@demo.example',
      displayName: 'Demo User',
      bio: 'The account the demo signs you in as. Everything here is fake.',
      role: 'member',
      tz: 'Europe/Madrid',
      locale: 'en',
      createdAt: at('2026-01-05T09:00:00Z'),
      updatedAt: at('2026-01-05T09:00:00Z'),
    },
    {
      // View-only by PERMISSION, not by hidden buttons: this account holds admin:read and never
      // admin:write. The same decision that refuses the call declines to render the control.
      id: id('user:admin'),
      handle: 'admin',
      email: 'admin@demo.example',
      displayName: 'Demo Admin',
      bio: 'Read-only operator. Can see everything, can change nothing.',
      role: 'admin',
      tz: 'UTC',
      locale: 'en',
      createdAt: at('2026-01-05T09:00:00Z'),
      updatedAt: at('2026-01-05T09:00:00Z'),
    },
    {
      id: id('user:ada'),
      handle: 'ada',
      email: 'ada@demo.example',
      displayName: 'Ada Okonjo',
      bio: 'Writes about databases. Friend of the demo user.',
      role: 'member',
      tz: 'America/New_York',
      locale: 'en',
      createdAt: at('2026-01-06T11:20:00Z'),
      updatedAt: at('2026-01-06T11:20:00Z'),
    },
    {
      id: id('user:bruno'),
      handle: 'bruno',
      email: 'bruno@demo.example',
      displayName: 'Bruno Salas',
      bio: 'Escribe en español. Amigo del usuario de la demo.',
      role: 'member',
      tz: 'Europe/Madrid',
      locale: 'es',
      createdAt: at('2026-01-07T08:00:00Z'),
      updatedAt: at('2026-01-07T08:00:00Z'),
    },
    {
      // No DST, so a scheduled digest must stay stable across March and November.
      id: id('user:kenji'),
      handle: 'kenji',
      email: 'kenji@demo.example',
      displayName: 'Kenji Mori',
      role: 'member',
      tz: 'Asia/Tokyo',
      locale: 'en',
      createdAt: at('2026-01-09T02:05:00Z'),
      updatedAt: at('2026-01-09T02:05:00Z'),
    },
    {
      // The one person with no prior relationship, so an OUTGOING pending request has a target
      // that does not collide with the incoming one from Kenji — a pair may hold one row, not two.
      id: id('user:noa'),
      handle: 'noa',
      email: 'noa@demo.example',
      displayName: 'Noa Klein',
      role: 'member',
      tz: 'UTC',
      locale: 'en',
      createdAt: at('2026-02-12T08:45:00Z'),
      updatedAt: at('2026-02-12T08:45:00Z'),
    },
    {
      // Southern hemisphere: DST runs the opposite way round from Madrid. Also the blocked party.
      id: id('user:mara'),
      handle: 'mara',
      email: 'mara@demo.example',
      displayName: 'Mara Ferrer',
      bio: 'Blocked the demo user. Her posts are public, and must vanish once you sign in as user.',
      role: 'member',
      tz: 'Pacific/Auckland',
      locale: 'es',
      createdAt: at('2026-02-11T14:30:00Z'),
      updatedAt: at('2026-02-11T14:30:00Z'),
    },
  ]);

  // Accepted both ways for ada and bruno; one request PENDING in each direction, because the
  // inbox and the outbox are different screens and a rule that only handles one is a rule with a
  // hole in it.
  await insert(friendships, [
    {
      requesterId: id('user:user'),
      addresseeId: id('user:ada'),
      status: 'accepted',
      respondedAt: at('2026-01-07T09:00:00Z'),
      createdAt: at('2026-01-06T12:00:00Z'),
    },
    {
      requesterId: id('user:bruno'),
      addresseeId: id('user:user'),
      status: 'accepted',
      respondedAt: at('2026-01-08T09:00:00Z'),
      createdAt: at('2026-01-07T09:30:00Z'),
    },
    {
      requesterId: id('user:kenji'),
      addresseeId: id('user:user'),
      status: 'pending',
      respondedAt: null,
      createdAt: at('2026-02-01T03:00:00Z'),
    },
    {
      // OUTGOING and pending: the outbox is a different screen from the inbox, and a rule that
      // only handles one direction is a rule with a hole in it. My comment above claimed this row
      // existed before it did — the friends screen rendering an empty outbox is what caught it.
      requesterId: id('user:user'),
      addresseeId: id('user:noa'),
      status: 'pending',
      respondedAt: null,
      createdAt: at('2026-02-02T09:00:00Z'),
    },
    {
      requesterId: id('user:user'),
      addresseeId: id('user:mara'),
      status: 'declined',
      respondedAt: at('2026-02-12T10:00:00Z'),
      createdAt: at('2026-02-11T15:00:00Z'),
    },
  ]);

  // Stored one way, applied both ways. The feed must hide Mara from the demo user AND the demo
  // user from Mara, from this single row.
  await insert(blocks, [
    {
      blockerId: id('user:mara'),
      blockedId: id('user:user'),
      createdAt: at('2026-02-12T11:00:00Z'),
    },
  ]);

  await insert(posts, [
    {
      id: id('post:tenancy'),
      authorId: id('user:ada'),
      body: 'Visibility here is relational, not a column. Who may read a post depends on friendship and blocks, so the rule lives in a policy rather than in a WHERE clause.',
      audience: 'public',
      likeCount: 2,
      commentCount: 1,
      publishedAt: at('2026-03-02T13:00:00Z'),
      createdAt: at('2026-03-02T13:00:00Z'),
      updatedAt: at('2026-03-02T13:00:00Z'),
    },
    {
      id: id('post:timezones'),
      authorId: id('user:bruno'),
      body: 'Nadie formatea una fecha sin zona horaria. Se guarda en UTC y se formatea en el borde, con la zona del lector.',
      audience: 'public',
      likeCount: 1,
      publishedAt: at('2026-03-09T07:30:00Z'),
      createdAt: at('2026-03-09T07:30:00Z'),
      updatedAt: at('2026-03-09T07:30:00Z'),
    },
    {
      // The demo user IS a friend of ada, so this one is visible to them and to nobody else.
      id: id('post:friends-only'),
      authorId: id('user:ada'),
      body: 'Friends-only: this post is the audience ladder doing its job. A stranger loading the public profile must not see it.',
      audience: 'friends',
      publishedAt: at('2026-03-11T18:00:00Z'),
      createdAt: at('2026-03-11T18:00:00Z'),
      updatedAt: at('2026-03-11T18:00:00Z'),
    },
    {
      // PUBLIC, and invisible TO THE DEMO USER specifically: a block beats the audience ladder.
      // It is correctly visible to an anonymous reader — Mara blocked one person, not the public —
      // so the anonymous feed showing it is the rule working, not a leak. Signed in as `user` it
      // must be absent; if it appears there, the ordering in `canSeePost` has regressed.
      id: id('post:blocked-author'),
      authorId: id('user:mara'),
      body: 'Written by someone who blocked the demo user. Public audience, so a signed-out reader sees it — and the demo user never does.',
      audience: 'public',
      publishedAt: at('2026-03-12T21:15:00Z'),
      createdAt: at('2026-03-12T21:15:00Z'),
      updatedAt: at('2026-03-12T21:15:00Z'),
    },
    {
      id: id('post:deleted'),
      authorId: id('user:bruno'),
      body: 'Soft-deleted. Invisible to everyone, its author included.',
      audience: 'public',
      deletedAt: at('2026-03-13T10:00:00Z'),
      publishedAt: at('2026-03-13T09:00:00Z'),
      createdAt: at('2026-03-13T09:00:00Z'),
      updatedAt: at('2026-03-13T10:00:00Z'),
    },
    {
      id: id('post:own'),
      authorId: id('user:user'),
      body: 'A private note. Only its author can read it, whatever their friends can see.',
      audience: 'private',
      publishedAt: at('2026-03-14T08:00:00Z'),
      createdAt: at('2026-03-14T08:00:00Z'),
      updatedAt: at('2026-03-14T08:00:00Z'),
    },
  ]);

  await insert(comments, [
    {
      id: id('comment:tenancy-1'),
      postId: id('post:tenancy'),
      authorId: id('user:user'),
      body: 'The composite key on likes is the part I keep forgetting to do.',
      createdAt: at('2026-03-03T01:12:00Z'),
    },
  ]);

  // The composite key is the idempotency mechanism: replaying either of these is a no-op at the
  // storage layer, not because a client remembered to de-duplicate.
  await insert(likes, [
    { postId: id('post:tenancy'), userId: id('user:user'), createdAt: at('2026-03-02T14:00:00Z') },
    { postId: id('post:tenancy'), userId: id('user:bruno'), createdAt: at('2026-03-03T01:10:00Z') },
    { postId: id('post:timezones'), userId: id('user:ada'), createdAt: at('2026-03-09T12:00:00Z') },
  ]);

  // Bun's own password hashing, not a hand-rolled one: `Bun.password` picks argon2id and encodes
  // the parameters into the hash, so a verify never has to be told which algorithm produced it.
  // Awaited at seed time rather than precomputed, because a committed hash is a committed secret
  // even when the password is "user".
  await insert(credentials, [
    { userId: id('user:user'), passwordHash: await Bun.password.hash('user') },
    { userId: id('user:admin'), passwordHash: await Bun.password.hash('admin') },
  ]);

  // One direct thread the demo user is in, and one they are NOT — the second exists so a
  // non-participant being refused is a case the screens can actually show.
  await insert(conversations, [
    { id: id('conv:user-ada'), kind: 'direct', createdAt: at('2026-03-04T09:00:00Z') },
    { id: id('conv:ada-bruno'), kind: 'direct', createdAt: at('2026-03-05T09:00:00Z') },
  ]);

  await insert(participants, [
    {
      conversationId: id('conv:user-ada'),
      userId: id('user:user'),
      lastReadAt: at('2026-03-04T09:05:00Z'),
      joinedAt: at('2026-03-04T09:00:00Z'),
    },
    {
      conversationId: id('conv:user-ada'),
      userId: id('user:ada'),
      joinedAt: at('2026-03-04T09:00:00Z'),
    },
    {
      conversationId: id('conv:ada-bruno'),
      userId: id('user:ada'),
      joinedAt: at('2026-03-05T09:00:00Z'),
    },
    {
      conversationId: id('conv:ada-bruno'),
      userId: id('user:bruno'),
      joinedAt: at('2026-03-05T09:00:00Z'),
    },
  ]);

  await insert(messages, [
    {
      id: id('msg:1'),
      conversationId: id('conv:user-ada'),
      authorId: id('user:ada'),
      body: 'Did the visibility rule end up in the policy or in the query?',
      createdAt: at('2026-03-04T09:01:00Z'),
    },
    {
      id: id('msg:2'),
      conversationId: id('conv:user-ada'),
      authorId: id('user:user'),
      body: 'The policy. A WHERE clause would be a second copy of it.',
      createdAt: at('2026-03-04T09:02:00Z'),
    },
    {
      // After the demo user's lastReadAt, so the unread badge has something to count.
      id: id('msg:3'),
      conversationId: id('conv:user-ada'),
      authorId: id('user:ada'),
      body: 'Good. Then blocking someone hides their posts everywhere at once.',
      createdAt: at('2026-03-06T18:00:00Z'),
    },
    {
      id: id('msg:4'),
      conversationId: id('conv:ada-bruno'),
      authorId: id('user:bruno'),
      body: 'Este hilo no es visible para el usuario de la demo.',
      createdAt: at('2026-03-05T09:10:00Z'),
    },
  ]);

  // One of each kind that matters, one already read, so the badge counts something real.
  await insert(notifications, [
    {
      id: id('notif:like'),
      userId: id('user:user'),
      kind: 'post-liked',
      actorId: id('user:bruno'),
      subjectId: id('post:tenancy'),
      createdAt: at('2026-03-03T01:10:00Z'),
    },
    {
      id: id('notif:request'),
      userId: id('user:user'),
      kind: 'friend-request',
      actorId: id('user:kenji'),
      subjectId: null,
      createdAt: at('2026-02-01T03:00:00Z'),
    },
    {
      id: id('notif:message'),
      userId: id('user:user'),
      kind: 'message',
      actorId: id('user:ada'),
      subjectId: id('conv:user-ada'),
      readAt: at('2026-03-06T18:05:00Z'),
      createdAt: at('2026-03-06T18:00:00Z'),
    },
  ]);

  // One attached image, one orphan the hourly sweep must collect. Keys, never URLs — the bucket
  // and the CDN host are deploy configuration.
  await insert(media, [
    {
      id: id('media:tenancy-cover'),
      postId: id('post:tenancy'),
      ownerId: id('user:ada'),
      key: 'demo/ada/tenancy-cover.jpg',
      kind: 'image',
      contentType: 'image/jpeg',
      bytes: 184_320,
      width: 1200,
      height: 630,
      state: 'attached',
      createdAt: at('2026-03-02T12:59:00Z'),
    },
    {
      id: id('media:orphan'),
      postId: null,
      ownerId: id('user:bruno'),
      key: 'demo/bruno/never-attached.jpg',
      kind: 'image',
      contentType: 'image/jpeg',
      bytes: 90_112,
      state: 'pending',
      createdAt: at('2026-03-01T00:00:00Z'),
    },
  ]);
});

/**
 * Seeds into the SAME driver the app reads through, which is the whole reason `driver` is exported
 * from `client.ts` rather than left as the module-private default.
 *
 * No decorator over the driver any more: `defineSeed`'s `insert` is one
 * `upsertAll(rows, { onConflict: <primary key>, onMatch: 'nothing' })`, so a replay is a no-op on
 * Postgres as well as in memory (packages/entity/src/seed.ts:274). This app hand-wrote that
 * decorator because the framework did not; it does.
 */
export const seedDemo = async (): Promise<void> => {
  await demo.run({ driver });
};

/**
 * Which rows the fixture owns, per entity — what a reset must NOT delete. Derived by replaying the
 * seed, so it cannot drift from the graph above; see `seededIds` for why deleting them is fatal.
 */
export const seededRowIds = (): Promise<ReadonlyMap<string, ReadonlySet<string>>> =>
  seededIds(demo);

if (import.meta.main) {
  await seedDemo();
  await Bun.stdout.write(`${JSON.stringify({ ok: true, seed: demo.name })}\n`);
}
