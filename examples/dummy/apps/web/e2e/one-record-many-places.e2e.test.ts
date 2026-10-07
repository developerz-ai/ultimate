/**
 * e2e — plan 101, done-when #1 and #3: one record shown by two islands on one page is ONE record.
 * A like in island A moves the count in island B with no refetch — the action's records envelope
 * (or one socket frame) reaches the page's one store, and every island reading that record
 * re-renders. The page opens exactly one `/_x/sync` socket, whatever its island count.
 *
 * CONTRACT this assumes of slice 16: `/posts/{id}` renders at least two islands that each show the
 * post's like count (`t('app.post.likes')`), and one of them carries the Like button. It fails
 * until the islands are migrated onto `useRecord` / `useMutation` — that is expected.
 *
 * And plan 101 sweep 9: a like's echo over the live socket settles its own overlay in the frame's
 * batch, so a live list never paints truth plus overlay (#507); the page runtime is ONE script per
 * page and both islands read the store it installed (#505).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ISLAND_MOUNTED_ATTRIBUTE } from '@ultimat3/render';
import type { E2eApp, E2eTab } from '@ultimat3/testing';
import { DEFAULT_CDP_TIMEOUT_MS, E2E_GOTO_MS, E2E_TAB_OPEN_MS } from '@ultimat3/testing';
import { ECHO_HOLD_SCRIPT, ECHO_HOLDS, echoHolds } from './fixtures/echo-hold';
import {
  everyCount,
  like,
  likeCounts,
  readNumbers,
  requestsSince,
  syncSockets,
  until,
} from './fixtures/page-reads';
import type { AcceptanceBrowser } from './fixtures/postly';
import {
  ACCEPTANCE_CLOSE_MS,
  ACCEPTANCE_OPEN_MS,
  acceptanceBrowser,
  DEMO_MEMBER_COOKIE,
  fail,
  noBrowser,
  POSTS,
  SIGN_IN_MS,
  serverLikeCount,
  signInAs,
  startPostly,
} from './fixtures/postly';

/** Where the in-page recorder keeps its history: a page global, since this test never reloads. */
const PAINTS = 'e2eOneRecordPaints';

/** Records each distinct set of this post's shown counts, one entry per observed mutation batch. */
const PAINT_RECORDER = `(() => {
  const seen = (globalThis[${JSON.stringify(PAINTS)}] = []);
  const record = () => {
    const now = ${likeCounts(POSTS.tenancy.id)}.join(',');
    if (seen[seen.length - 1] !== now) seen.push(now);
  };
  record();
  new MutationObserver(record).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-like-count'],
  });
  return true;
})()`;

describe.skipIf(noBrowser)('one record, many places', () => {
  let app: E2eApp;
  let browser: AcceptanceBrowser;
  let tab: E2eTab;

  beforeAll(
    async () => {
      app = await startPostly();
      browser = await acceptanceBrowser();
      await signInAs(browser.session, app, 'ada');
      tab = await browser.session.newTab();
      await tab.goto(`${app.base}/posts/${POSTS.tenancy.id}`);
    },
    ACCEPTANCE_OPEN_MS + SIGN_IN_MS + E2E_TAB_OPEN_MS + E2E_GOTO_MS,
  );

  afterAll(async () => {
    await tab?.close();
    await browser?.close();
    await app?.stop();
  }, ACCEPTANCE_CLOSE_MS + DEFAULT_CDP_TIMEOUT_MS);

  test('a like in one island moves the count in the other, from one write, with no refetch', async () => {
    const { session } = browser;
    await tab.waitFor(
      `${likeCounts(POSTS.tenancy.id)}.length >= 2`,
      'two places on /posts/{id} that each show the like count',
    );
    await until(() => syncSockets(session, app.base) >= 1, 'the page to open its /_x/sync socket');
    // Ada has not liked Tenancy in the seed: bruno and kenji have.
    expect(await readNumbers(tab, likeCounts(POSTS.tenancy.id))).toEqual(
      expect.arrayContaining([2, 2]),
    );

    // The like control's channel is live once its first catch-up read has landed. Marked before
    // that, the log would catch that read and call it a refetch the like caused.
    await tab.waitFor(
      `document.querySelector('[data-channel="live"]') !== null`,
      "the like control's channel to go live",
    );
    // Every paint of the counts from here on. A MutationObserver delivers once per task, so one
    // store write re-rendering both islands is ONE entry; two islands each moved by their own read
    // leave an entry in between where they disagree — which the end state alone cannot show.
    await tab.evaluate(PAINT_RECORDER);
    const mark = session.requests().length;
    await like(tab, POSTS.tenancy.id);
    await tab.waitFor(everyCount(POSTS.tenancy.id, 3), 'EVERY island to show 3 likes');

    // One write went out, and no island went back to the server to re-read what it now shows —
    // neither a live query nor an action read (`postRecord` is a GET under /api). The optimistic
    // paint lands before the POST leaves: the write is sent after one read of the durable queue (a
    // write never overtakes one another tab queued), so wait for it before counting.
    await until(
      () => requestsSince(session, app.base, mark, /^POST .*\/api\/posts\/like/).length >= 1,
      "the like's write to reach the server",
    );
    expect(requestsSince(session, app.base, mark, /^POST .*\/api\/posts\/like/)).toHaveLength(1);
    expect(requestsSince(session, app.base, mark, /^GET .*\/_x\/query\//)).toEqual([]);
    expect(requestsSince(session, app.base, mark, /^GET .*\/api\//)).toEqual([]);
    // Moved together: no paint where one island showed the new count and another the old.
    const painted = await tab.evaluate(`globalThis[${JSON.stringify(PAINTS)}] ?? null`);
    if (!Array.isArray(painted)) return expect.unreachable('the paint recorder kept no history');
    const paints = painted.map((entry) => String(entry).split(','));
    expect(paints.some((counts) => counts.length >= 2 && counts.every((n) => n === '3'))).toBe(
      true,
    );
    expect(paints.filter((counts) => new Set(counts).size > 1)).toEqual([]);
    // One socket for the page, however many islands it holds — and no reconnect along the way.
    expect(syncSockets(session, app.base)).toBe(1);
    // The islands move optimistically; the server's own render is the proof the write landed.
    await until(
      async () => (await serverLikeCount(app, 'ada', 'tenancy')) === 3,
      "the server's render to show 3 likes",
    );
  }, 60_000);

  /**
   * Sweep 10d B17. A like is insert-or-ignore on the server, so liking a post the member ALREADY
   * likes changes nothing — and the screen must say so. The twin skips a row whose `likedByMe` is
   * set; until `postRecord` carried that flag per actor, a fresh page seeded it `false` and the
   * click painted +1, then dropped back when the server's unchanged count landed.
   */
  test('a like on a post the member already likes paints no +1 at all', async () => {
    // Timezones: Ada liked it in the seed, so its one like is hers.
    const post = POSTS.timezones;
    const own = await browser.session.newTab();
    try {
      await own.goto(`${app.base}/posts/${post.id}`);
      await own.waitFor(`${likeCounts(post.id)}.length >= 2`, 'both places showing the count');
      await own.waitFor(
        `document.querySelector('[data-channel="live"]') !== null`,
        "the like control's channel to go live",
      );
      // The seed read has landed: the record the twin reads is in the store, flag included.
      await own.waitFor(`${syncedLikeCount(post.id)} === 1`, 'the seeded record in the store');
      expect(await serverLikeCount(app, 'ada', 'timezones')).toBe(1);

      await own.evaluate(paintRecorder(LIKED_PAINTS, post.id));
      const mark = browser.session.requests().length;
      await like(own, post.id);
      await until(
        () =>
          requestsSince(browser.session, app.base, mark, /^POST .*\/api\/posts\/like/).length === 1,
        'the like to go out',
      );
      await own.waitFor(
        `globalThis[Symbol.for('ultimate.realtime')].store.pending().length === 0`,
        'the like to settle',
      );

      // One paint, the count it opened with: no frame ever showed 2.
      expect(await paintsOf(own, LIKED_PAINTS)).toEqual([
        (await readNumbers(own, likeCounts(post.id))).map(() => '1').join(','),
      ]);
      expect(await serverLikeCount(app, 'ada', 'timezones')).toBe(1);
    } finally {
      await own.close();
    }
  }, 60_000);
});

/** Where the already-liked case keeps its paint history. */
const LIKED_PAINTS = 'e2eAlreadyLikedPaints';

/** Where this describe's two recorders keep their histories. */
const FEED_PAINTS = 'e2eFeedEchoPaints';
const BADGE_PAINTS = 'e2eSharedStorePaints';

/** A string only realtime's `record-store.ts` holds — in a script exactly when the store's code is. */
const STORE_CODE = 'it arrived under an empty key';

/** Every distinct set of this post's shown counts, one entry per observed mutation batch. */
const paintRecorder = (global: string, postId: string): string => `(() => {
  const seen = (globalThis[${JSON.stringify(global)}] = []);
  const record = () => {
    const now = ${likeCounts(postId)}.join(',');
    if (seen[seen.length - 1] !== now) seen.push(now);
  };
  record();
  new MutationObserver(record).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-like-count'],
  });
  return true;
})()`;

/** What a paint recorder kept, as text — `fail`s rather than answering an empty history. */
async function paintsOf(tab: E2eTab, global: string): Promise<readonly string[]> {
  const painted = await tab.evaluate(`globalThis[${JSON.stringify(global)}] ?? null`);
  if (!Array.isArray(painted)) return fail(`the paint recorder ${global} kept no history`);
  return painted.map(String);
}

/** The page store's SYNCED row for a post — server truth, no overlay — as the page holds it. */
const syncedLikeCount = (postId: string): string =>
  `globalThis[Symbol.for('ultimate.realtime')]?.store?.synced('posts', ${JSON.stringify(postId)})?.likeCount ?? null`;

/** Every hydrating island on the page has run its `mount`. */
const allMounted = `(() => {
  const islands = [...document.querySelectorAll('[data-x-island]:not([data-x-hydrate="never"])')];
  return islands.length > 0 && islands.every((el) => el.hasAttribute('${ISLAND_MOUNTED_ATTRIBUTE}'));
})()`;

describe.skipIf(noBrowser)('one record, many places: the echo and the runtime', () => {
  let app: E2eApp;
  let browser: AcceptanceBrowser;

  beforeAll(async () => {
    app = await startPostly();
    // Every tab of this browser holds a like's HTTP answer until the socket's echo has landed.
    browser = await acceptanceBrowser(ECHO_HOLD_SCRIPT);
    await signInAs(browser.session, app, 'ada');
  }, ACCEPTANCE_OPEN_MS + SIGN_IN_MS);

  afterAll(async () => {
    await browser?.close();
    await app?.stop();
  }, ACCEPTANCE_CLOSE_MS);

  test('a like echoed over the live socket before its answer never paints truth plus overlay', async () => {
    const { session } = browser;
    // Tenancy: Ada has not liked it in the seed, so her like moves the server's count.
    const post = POSTS.tenancy;
    const tab = await session.newTab();
    try {
      await tab.goto(`${app.base}/feed`);
      await tab.waitFor(`${likeCounts(post.id)}.length === 1`, "the feed's row for the post");
      await until(() => syncSockets(session, app.base) >= 1, 'the feed to open its socket');
      // The live query's snapshot is in the store: the hold has a synced count to see move.
      await tab.waitFor(`${syncedLikeCount(post.id)} !== null`, 'the snapshot in the store');
      const [shown] = await readNumbers(tab, likeCounts(post.id));
      if (typeof shown !== 'number') return fail('the feed row shows no like count');
      const before = shown;
      expect(await serverLikeCount(app, 'ada', 'tenancy')).toBe(before);

      await tab.evaluate(paintRecorder(FEED_PAINTS, post.id));
      await like(tab, post.id);
      await tab.waitFor(
        `(globalThis[${JSON.stringify(ECHO_HOLDS)}] ?? []).every((hold) => hold.done) && (globalThis[${JSON.stringify(ECHO_HOLDS)}] ?? []).length === 1`,
        "the like's answer to be handed back",
      );
      // The store has no write left in flight: the answer's settle has run too.
      await tab.waitFor(
        `globalThis[Symbol.for('ultimate.realtime')].store.pending().length === 0`,
        'the like to settle',
      );

      // The race went the way under test: the socket's patch reached the store BEFORE the answer.
      const holds = echoHolds(await tab.evaluate(`globalThis[${JSON.stringify(ECHO_HOLDS)}]`));
      expect(holds).toEqual([
        { postId: post.id, before, after: before + 1, echoed: true, done: true },
      ]);
      // Every paint across the round trip: the old count, then the new one — and nothing else. The
      // frame landed under a pending overlay; had it not settled that overlay in its own batch, the
      // twin replayed over truth would have painted `before + 2` until the answer took it back.
      expect(await paintsOf(tab, FEED_PAINTS)).toEqual([String(before), String(before + 1)]);
      expect(await serverLikeCount(app, 'ada', 'tenancy')).toBe(before + 1);
    } finally {
      await tab.close();
    }
  }, 60_000);

  test('two islands on /posts/{id} read ONE store, from ONE runtime script', async () => {
    const post = POSTS.timezones;
    const tab = await browser.session.newTab();
    try {
      await tab.goto(`${app.base}/posts/${post.id}`);
      await tab.waitFor(`${likeCounts(post.id)}.length >= 2`, 'both places showing the count');
      await tab.waitFor(allMounted, "the page's islands to mount");

      // The scripts THIS document loaded, off its own resource timeline: the service worker's
      // precache fetches the same files again in its own realm, on its own schedule, and a count
      // over every request the browser sent is a count of that race.
      const loaded = await tab.evaluate(
        `performance.getEntriesByType('resource').map((entry) => entry.name)`,
      );
      if (!Array.isArray(loaded)) return fail('the page answered no resource timeline');
      const origin = new URL(app.base).origin;
      const scripts = loaded
        .map(String)
        .filter((url) => new URL(url).origin === origin && new URL(url).pathname.endsWith('.js'));
      const boots = scripts.filter((url) => new URL(url).pathname.startsWith('/_x/page-boot/'));
      const islands = scripts.filter((url) => new URL(url).pathname.startsWith('/islands/'));
      expect(boots).toHaveLength(1);
      expect(islands.length).toBeGreaterThanOrEqual(2);
      // By the bytes, never by a file name (the runtime chunk is named differently by `x dev` and
      // `x build`): of every script the page fetched, the store's code is in the page boot alone —
      // no island carries a copy, and no island fetched the runtime chunk beside the boot.
      const holding: string[] = [];
      for (const url of new Set(scripts)) {
        const response = await fetch(url, {
          headers: { cookie: `${DEMO_MEMBER_COOKIE}=ada` },
        });
        expect(response.status).toBe(200);
        if ((await response.text()).includes(STORE_CODE)) holding.push(url);
      }
      expect(holding).toEqual(boots);

      // By behaviour: one write into THE page's store moves both islands, in one paint. An island
      // reading a store of its own would keep the server's count.
      const counts = await readNumbers(tab, likeCounts(post.id));
      await tab.evaluate(paintRecorder(BADGE_PAINTS, post.id));
      await tab.evaluate(
        `globalThis[Symbol.for('ultimate.realtime')].store.merge('posts', ${JSON.stringify(post.id)}, { likeCount: 41 })`,
      );
      await tab.waitFor(everyCount(post.id, 41), 'every island to show the store write');
      expect(await paintsOf(tab, BADGE_PAINTS)).toEqual([
        counts.join(','),
        counts.map(() => '41').join(','),
      ]);
    } finally {
      await tab.close();
    }
  }, 60_000);
});
