// `x new <name> --shape offline`: an installable app that keeps working with no network. The
// default app — its PWA, offline fallback and `post` slice — with the post form written through
// realtime's outbox, `createPost` safe to replay, both proven offline in a real browser, and the
// README's recipe for a phone on the LAN (`x dev --host <address> --tls`).

import { catalogJson } from '../catalog-json';
import { catalogPath } from '../locales';
import type { GeneratedFile, NameSet } from '../naming';
import { FALLBACK_E2E, offlineE2eFiles, WRITE_E2E } from './offline-e2e';
import { offlineFormFiles } from './offline-form';
import type { ShapeEdit, ShapeOverlay } from './overlay';
import { shapeLines } from './shared-edits';

const PAGE = 'apps/web/app/posts/page.tsx';
const CREATE = 'apps/web/app/post/actions/create-post.ts';
const README_LAYOUT = '## 🗺 Layout\n';

const BUDGET = `  // measured: 64,167 B (\`x build --target static\`, Bun 1.4.4) — the form island and the
  // \`visible\` runtime. why: the form is Solid, @ultimat3/ui's Form/Input/Button and the transport.
  // A raise states its own measured bytes and why here, in the same diff (\`X_BUDGET_EXCEEDED\`).
  budget: { js: '66kb' },`;

const OFFLINE_BUDGET = `  // measured: 158,171 B (\`bunx x verify --only budgets\`, Bun 1.4.4, 2026-11-16) — the page boot
  // 84,606 + the form island 72,293 + inline scripts 1,272. why: the form writes through
  // \`@ultimat3/realtime\`'s outbox, so this page loads the page boot (the record store and the
  // IndexedDB outbox that replays a write made offline) beside the form; the default form's
  // transport-only island was 64,167 B. A raise states its own measured bytes and why here, in the
  // same diff (\`X_BUDGET_EXCEEDED\`).
  // raised 155kb → 156kb, measured: 158,737 B (2026-11-17) — the page boot 84,889 + the island
  // 72,576 + inline 1,272. why: +12 B in each chunk, \`uuidV7\` minting at timestamp 0 for a clock
  // before 1970 (it used to throw), in core's ids, which both chunks carry.
  budget: { js: '156kb' },`;

const lan = (): string => `## 📶 Offline, and on your LAN

A service worker registers only on a secure origin — \`localhost\`, or https — so a phone on your
network needs TLS to install this app. Bind your machine's LAN address and serve it over https:

\`\`\`sh
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I | cut -d' ' -f1)
bunx x dev --host "$LAN_IP" --tls
\`\`\`

\`--tls\` writes a self-signed certificate for \`localhost\` and that address to \`.x/tls/cert.pem\`.
Trust it once on the device (install it as a CA profile), open \`https://$LAN_IP:3000\`, and
install the app from the browser menu. Then cut the network:

| Offline | What answers |
|---|---|
| a page the worker cached, or \`/offline\` | the cache — \`offline:\` on each route decides (\`apps/web/site/offline/page.tsx\` is \`precache\`) |
| a personal page (\`/posts\`) | the offline document: a page rendered for someone is never cached |
| a new post | the outbox — \`apps/web/app/post/post-form.island.tsx\` writes through \`useMutation\`, and a write the network refuses waits in IndexedDB, then replays on reconnect under its idempotency key (\`createPost\` is \`idempotent: true\`) |

\`${FALLBACK_E2E}\` and \`${WRITE_E2E}\` prove both with the network cut, on every \`bun run verify\`.
The sync socket stays plaintext under \`--tls\`, so over a LAN origin live updates wait for a reload;
reads and writes are https.

`;

const edits = (): readonly ShapeEdit[] => [
  // The form's path is \`useMutation\`'s to derive now: no endpoint prop, no \`derivePath\`.
  { path: PAGE, find: "import { derivePath } from '@ultimat3/action';\n", replace: '' },
  {
    path: PAGE,
    find: "  props: ['endpoint', 'locale', 'currency', 'labels'],",
    replace: "  props: ['locale', 'currency', 'labels'],",
  },
  { path: PAGE, find: "            endpoint={derivePath('createPost').path}\n", replace: '' },
  {
    path: PAGE,
    find: "              retry: t('app.post.retry'),\n",
    replace:
      "              queued: t('app.post.queued'),\n              retry: t('app.post.retry'),\n",
  },
  { path: PAGE, find: BUDGET, replace: OFFLINE_BUDGET },
  {
    path: 'apps/web/app/posts/page.test.ts',
    find: "  expect(page.config.budget.js).toBe('66kb');",
    replace: "  expect(page.config.budget.js).toBe('156kb');",
  },
  // A write replayed from the outbox may already have landed: the key answers it, never twice.
  {
    path: CREATE,
    find: '  cache: { invalidates: [postTag] },\n',
    replace:
      '  cache: { invalidates: [postTag] },\n  // The outbox replays a write whose answer was lost under the SAME Idempotency-Key: this is what\n  // makes that replay answer the first result instead of inserting a second post.\n  idempotent: true,\n',
  },
  { path: 'README.md', find: README_LAYOUT, replace: `${lan()}${README_LAYOUT}` },
  ...shapeLines(
    'offline',
    'an installable app that works with no network — the `post` form queues a write offline (`apps/web/app/post/post-form.island.tsx`) and replays it on reconnect; README.md says how to open it from a phone on your LAN',
  ),
];

/** The one key the queued state reads, merged into the catalog the base wrote. */
const catalog = (): GeneratedFile => ({
  path: catalogPath('en'),
  merge: 'json',
  contents: catalogJson({
    'app.post.queued': 'Saved on this device. It will send when you are back online.',
  }),
});

export const offlineShape: ShapeOverlay = {
  example: true,
  drop: [],
  dropKeys: [],
  edits,
  files: (app: NameSet): readonly GeneratedFile[] => [
    ...offlineFormFiles(),
    ...offlineE2eFiles(app),
    catalog(),
  ],
};
