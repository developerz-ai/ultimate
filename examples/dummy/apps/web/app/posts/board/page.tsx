/**
 * The posts board: the org's posts in a column per status, a card moved between Draft and
 * Scheduled by pointer, touch or keyboard — and with scripting off, by the target `select` each
 * card carries, posting natively to the same `movePostStatus` the island calls. One action, four
 * ways in.
 *
 * `render: 'ssr'`: the one read is the org's recent posts, resolved in `load` through the typed
 * query client before the document is written. The server's `Board` IS the no-script page; the
 * island replaces it with the same board, live.
 */

import { useT } from '@postly/i18n';
import { derivePath } from '@ultimat3/action';
import type { KnownPermission } from '@ultimat3/policy';
import { defineRoute, island } from '@ultimat3/render';
import { Board, PageHeader, uiCatalog } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import type { Api } from '../../../api';
import { useActor } from '../../../shared/actor';
import { memberQueries } from '../../../shared/client';
import { Layout, updateBannerIsland } from '../../layout';
import { useViewer } from '../../viewer-context';
import { MOVE_FIELDS, postCard } from './board-card';
import { type BoardLabels, type BoardPost, boardColumns, canMovePost } from './board-columns';

/** `movePostStatus` → its derived route, named once and checked by the compiler. */
const MOVE_ENDPOINT = derivePath('movePostStatus' satisfies keyof Api['actions']).path;

/** Declared ABOVE `defineRoute` so the route can drain it. `props` are the browser's keys. */
const PostBoard = island({
  src: './board.island.tsx',
  props: ['locale', 'zone', 'posts', 'labels', 'action', 'ui'],
});

/** The layout's update banner — an island of THIS route, so it is declared here. */
const Banner = updateBannerIsland('../../update-banner.island.tsx');

export const config = defineRoute({
  render: 'ssr',
  /** The org's posts are not public; `orgPosts`' own `feedRead` still decides the org. */
  policy: { permission: 'post:read' satisfies KnownPermission },
  offline: 'runtime',
  hydrate: 'idle',
  /**
   * Was 193,620 B (2026-11-06; the board island 77,589 by `buildIslands`, plus what every
   * live `app/` document carries as `/runs` measured it: the page boot 82,123, the router 29,570,
   * `/x-client-vitals.js` 1,202, the inline runtime 2,426, the update banner 710), against 195,072.
   * why: the board is the gesture — `Board` and `sort-surface.tsx` over `drag/` (pointer capture,
   * auto-scroll, keyboard lift and drop, announcements), keyed cards — plus the typed client's
   * `movePostStatus` and `UiProvider` with the server's `ui.*` strings.
   * Was 109533 B (2026-11-06; x build --target static, the document as served), because the
   * figure above was computed, not built, and charged a page boot this page never loads (its
   * island reads no live query): the board island 76,086 (after ui's per-key `ui-keys.ts`), the
   * router 29,570, the vitals 1,202, the banner 710, inline 1,965 — lowered 190.5kb → 107.5kb
   * (plan 101 wave 10).
   * measured: 110333 B (2026-11-07, sweep 1; x build --target static) — why: the board island
   * 76,086 → 76,703, `SortableList` stepping a second Alt+Arrow from the held move and releasing
   * only its own hold, and the router +122 B — raised 107.5kb → 108kb.
   * measured: 110687 B (2026-11-09, plan 101 sweep 1; x build --target static) — why: the board
   * island 76,843 → 77,057 (+214 B), core's `boundedCause` in `UltimateError`'s constructor: every
   * cause, a decoded problem's included, is cut at 4 KiB. Raised 108kb → 108.25kb.
   * measured: 110898 B (2026-11-09, plan 101 sweep B; x build --target static) — why: the board
   * island 77,057 → 77,196 (+139 B), the action client and core's decoder carrying a problem's
   * `issuesTruncated` onto the client error, so a cut issue list says it was cut. Raised
   * 108.25kb → 108.3kb.
   * measured: 110925 B (2026-11-09, plan 101 wave C; x build --target static, against 110,898)
   * — why: core's `singleLine` reading its escape table through `Object.hasOwn` (+27 B), so a
   * key on `Object.prototype` is never taken for an escape. Raised 108.3kb → 108.4kb.
   * measured: 111061 B (2026-11-11, plan 101 efficiency sweep 1; x build --target static) — why:
   * the board island 77,270 → 77,359 (+89 B), core's error-code title table gaining
   * `X_IMAGE_RASTER_BUDGET`, so a client decoding that refusal knows its title. Raised 108.4kb →
   * 108.5kb.
   */
  // raised 108.5kb → 108.6kb. measured: 111181 B (2026-11-12; x build --target static) — why: the
  // client router grew 29,764 → 29,884 (+120 B): a stylesheet that fails to load on navigation now forces a
  // full load and keeps the old sheets, so a page is never left unstyled.
  // raised 108.6kb → 108.8kb. measured: 111323 B (2026-11-12, plan 101 sweep 11; x build --target
  // static, against 111,181) — why: the board island 77,359 → 77,501 (+142 B), `mountOver` from
  // `@ultimat3/render/client`: a render that throws puts the server's board back, not a blank box.
  // measured: 112703 B (2026-11-14, plan 101 sweep 1; x build --target static, against 111,323
  // at origin/main) — why: the board island +1,380 B (78,881 B): `defineError` takes `problemMeta`
  // and `publicCause` in the code's one declaration (the meta key rule, the app meta table and the
  // public-cause set, refused all-or-nothing; +1,221 B), and two framework titles in core's titles table the island carries through the barrel, `X_REDACT_PATTERN_UNSAFE` (`redactValues()`) and `X_OUTBOUND_PROXY_INVALID` (`outbound({ proxy })`) (+159 B). Raised
  // 108.8kb → 110.1kb.
  // measured: 112847 B (2026-11-15, plan 101 sweep 3; x build --target static) — why: the board
  // island +144 B (79,025 B): the drag takes back the pointer capture the browser drops when a card
  // moves columns (a cross-column drag cancelled half way) and cancels when it cannot. Raised
  // 110.1kb → 110.3kb.
  // measured: 112,991 B (2026-11-16, plan 101b sweep 8b-2; x build --target static) — why: the
  // board island +89 B: the action and query clients trim their base URL with `@ultimat3/core`'s
  // linear `trimTrailingSlashes`, the one trim that replaced the quadratic `/\/+$/` at 26 sites
  // (CodeQL js/polynomial-redos). Raised 110.3kb → 110.4kb.
  // measured: 113106 B (2026-11-18; x build --target static, against 112,991) — why: +115 B, the
  // action client's title for `X_REPLAY_PRINCIPAL_MISMATCH`, the refusal of an offline write
  // replayed under another session. Raised 110.4kb → 110.5kb.
  // measured: 113869 B (2026-11-19; x build --target static) — why: +763 B, the board island +618 B
  // (79,258 → 79,876): `clientStream` reviving a chunk frame's `dates:` and coding a mid-body cut
  // as `X_CLIENT_TRANSPORT_FAILED`, `clientTransport` sending a write with no idempotency key once,
  // `isRtl` reading a script subtag (`az-Arab` rtl), `t.has` true for a select or ordinal family
  // authored only in plural forms, and a sortable item deleted by a live update while lifted no
  // longer blocking keyboard sorting; the client router +45 B (29,910 → 29,955), a soft navigation
  // to a malformed fragment (`#50%`) still runs scripts and fires `ultimate:navigated`, and
  // `navigate()` to a fragment of the page on screen scrolls instead of refetching and disposing
  // its islands; the inline hydration runtime +100 B, an island boots with the props inside its own
  // wrapper, not the first script in the document with its id (a modal's island took the page's).
  // Against 113,106, origin/main built the same way. Raised 110.5kb → 111.3kb.
  // measured: 115814 B (2026-11-24; x build --target static) — why: the client router +1,949 B
  // (29,955 → 31,904): a soft visit to a `stream` page reads the answer as it arrives, swaps
  // the shell in at the server's flush mark and fills each hole as its chunk lands, so the page
  // paints before its slowest hole (65 ms p95 against 2,041 ms). Raised 111.3kb → 113.1kb.
  // measured: 123485 B (2026-11-24; x build --target static, against 115,814) — why: the board
  // island +7,667 B (79,876 → 87,543): `Board` gains card selection — a native checkbox per card,
  // Shift+click and the grid keys ranging in reading order, a long press on touch, the prune of a
  // card that left the board, and `BulkBar` with its live count and "all matching" box — carried by
  // `sort-surface.tsx`, which every `Board` and `SortableList` shares; the review's fixes (boxes
  // reconciled to `value`, the native mixed state, per-list memos) are 952 B of it. The selection
  // stays in a board that never sets it: its no-script boxes render in the same synchronous pass,
  // and the barrel is the one import path. Raised 113.1kb → 120.6kb.
  // measured: 124201 B (2026-11-24; x build --target static) — why: the client router +716 B
  // (31,904 → 32,620): a streamed soft visit scrolls to a fragment its hole brings, holds its
  // recovery while the next visit is on its way, reloads a fragment URL it must load for real,
  // and drops keep-alive frames as they arrive. Raised 120.6kb → 121.3kb.
  budget: { js: '121.3kb' },
  load: () => memberQueries.orgPosts({ orgId: useActor().orgId }),
  meta: ({ t }) => ({ title: t('app.board.metaTitle'), robots: { index: false } }),
});

type Posts = Awaited<ReturnType<typeof memberQueries.orgPosts>>;

/** Every word the board shows, translated here: a catalog cannot cross the wire. */
const boardLabels = (t: ReturnType<typeof useT>): BoardLabels => ({
  board: t('app.board.label'),
  columns: {
    draft: t('app.board.status.draft'),
    scheduled: t('app.board.status.scheduled'),
    published: t('app.board.status.published'),
  },
});

export function Page(props: { readonly data: Posts }): JSX.Element {
  const t = useT();
  const viewer = useViewer();
  const posts: BoardPost[] = props.data.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
  }));
  const labels = boardLabels(t);

  return (
    <Layout banner={Banner} here="/posts/board">
      <PageHeader title={t('app.board.heading')} description={t('app.board.intro')} />
      <PostBoard
        locale={t.locale}
        zone={viewer.zone}
        posts={posts}
        labels={labels}
        action={MOVE_ENDPOINT}
        ui={uiCatalog(t)}
      >
        {/* The no-script board: a real form per card, posting to `movePostStatus`. */}
        <Board
          groups={boardColumns(posts, labels.columns)}
          itemKey={(post: BoardPost) => post.id}
          renderItem={postCard}
          label={labels.board}
          onMove={() => undefined}
          canDrop={canMovePost}
          action={MOVE_ENDPOINT}
          fields={MOVE_FIELDS}
        />
      </PostBoard>
    </Layout>
  );
}
