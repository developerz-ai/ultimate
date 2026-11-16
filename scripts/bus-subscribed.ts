#!/usr/bin/env bun
// Enforce, as a gate step, that a live test never publishes on a real bus before the bus holds the
// subscription meant to hear it. A SUB written and not yet read by the server loses whatever another
// connection publishes meanwhile — at-most-once by design — and the test reads that as a flake
// (`3f6d1b24d`, #1132). Before each `await ….publish(` / `.publishEvent(` in a `.live.test.ts`, the
// latest bus step in its test must be an awaited CONFIRMATION — `subscribed()` (packages/realtime's
// `bus-subscribed-fixture.ts`), `await x.subscribe(` / `subscribeChannel(` (they resolve once the
// server holds it) — and no connection step (a wait on `.connected`, a relay cut, hold, release or
// stop, `relayTo(`, a `CLIENT KILL`) may lie between them: a reconnect re-sends every SUB unread.
// A publish meant to be lost, or one a round trip the scan cannot read already ordered (a hub's
// awaited bridge behind a page that reads `live`), says so: `// bus-order: <why>` on the line or
// the one above.
//
//   bun run scripts/bus-subscribed.ts [--json]
//   bun run scripts/bus-subscribed.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { renderFixShellArg } from '../packages/core/src/error-render';
import { stripComments } from '../packages/core/src/source-mask';
import { BUS_SUBSCRIBED_PINS, PINS_FILE } from './lib/bus-subscribed-pins';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { readTestSources } from './test-fix-citations';

const SCRIPT = 'bus-subscribed';
const EXPLAIN = 'bun run scripts/bus-subscribed.ts --explain --json lists every one';

/** A publish the test awaits: what a delivery assertion follows. */
const PUBLISH = /\bawait\s+[\w$.?[\]'"]+\.publish(?:Event)?\s*\(/;
/** An awaited confirmation: the bus answers it only once the server holds the subscription. */
const CONFIRM = /\bawait\b.*\b(?:subscribed\w*|subscribe|subscribeChannel|listen)\s*\(/;
/**
 * A file on a FANOUT bus: a transport, a pub/sub, a subscription. A durable event table
 * (`@ultimat3/jobs`' `postgresEventBus`, read back by `find`) is published to and never subscribed,
 * so nothing there is lost to a race, and a `LISTEN` alone does not bring a file in.
 */
const FANOUT = /Transport\b|PubSub\b|\.subscribe\s*\(|\bsubscribed\s*\(/;
/** A step after which the server may hold the subscription no longer. */
const CONNECTION =
  /\.connected\b|\brelay\w*\.(?:cut|hold|release|stop)\s*\(|\brelayTo\s*\(|CLIENT['",\s]+KILL/;
/** Where a test's own steps begin: a confirmation above it belongs to another test. */
const TEST_START = /\b(?:test|it)(?:\.\w+)*\s*\(/;
/** The escape, as a line comment on the line or the one above; a reason is required. */
export const BUS_ORDER = /\/\/\s*bus-order:\s*\S.{2,}/;

export interface BusPublishSite {
  readonly path: string;
  readonly line: number;
  /** What the latest bus step before it was: `nothing`, or the connection step's line. */
  readonly after: string;
}

/** Every awaited publish in one live test file whose latest bus step is not a confirmation. */
export function scanBusPublishes(path: string, source: string): readonly BusPublishSite[] {
  if (!path.endsWith('.live.test.ts') || !source.includes('publish')) return [];
  if (!FANOUT.test(source)) return [];
  const code = stripComments(source).split('\n');
  const lines = source.split('\n');
  const out: BusPublishSite[] = [];
  for (let at = 0; at < code.length; at += 1) {
    if (!PUBLISH.test(code[at] ?? '')) continue;
    if (BUS_ORDER.test(lines[at] ?? '') || BUS_ORDER.test(lines[at - 1] ?? '')) continue;
    let after = 'nothing';
    for (let back = at - 1; back >= 0; back -= 1) {
      const text = code[back] ?? '';
      if (CONFIRM.test(text)) {
        after = '';
        break;
      }
      if (CONNECTION.test(text)) {
        after = `the connection step at line ${String(back + 1)}`;
        break;
      }
      if (TEST_START.test(text)) break;
    }
    if (after !== '') out.push({ path, line: at + 1, after });
  }
  return out;
}

export type BusPublishGap = RatchetGap<BusPublishSite>;

export interface BusPublishInput {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly pins: PinTable;
}

export const checkBusPublishes = (input: BusPublishInput): readonly BusPublishGap[] =>
  ratchetGaps(
    input.files.flatMap((file) => scanBusPublishes(file.path, file.text)),
    input.pins,
    input.files.length > 0,
  );

const at = (site: BusPublishSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)} (after ${site.after})`;

const overFinding = (gap: BusPublishGap): Finding => ({
  code: 'X_TEST_BUS_UNCONFIRMED',
  cause: `${gap.pkg} has ${String(gap.found)} live-test publish(es) with no awaited subscription confirmation before them and is pinned at ${String(gap.pinned)} — ${siteList(gap, at, EXPLAIN)} — a publish that beats the server to the SUB is lost, and the test that waits for it is a flake`,
  fix: `const held = await subscribed({ subscriber, publisher, subject, handler });   # at ${siteTarget(gap, at)}, from packages/realtime/src/bus-subscribed-fixture.ts — after a reconnect, await held.subscribed() before the next publish. A publish meant to be lost, or ordered by a round trip the scan cannot read: "// bus-order: <why>" on the line or the one above`,
  at: leadSite(gap)?.path ?? PINS_FILE,
});

const staleFinding = (gap: BusPublishGap): Finding => ({
  code: 'X_TEST_BUS_UNCONFIRMED_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} unconfirmed live-test publish(es) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/bus-subscribed.ts --unpin ${renderFixShellArg(gap.pkg, '<pkg>')}`,
  at: PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_TEST_BUS_UNCONFIRMED_UNSCANNED',
  cause:
    'no test file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a clean tree',
  fix: "bun run scripts/bus-subscribed.ts --explain --json   # reads nothing: TEST_GLOBS in scripts/test-fix-citations.ts must match this repo's test layout",
  at: 'scripts/bus-subscribed.ts',
});

export const busPublishFindingFor = (gap: BusPublishGap): Finding =>
  gap.kind === 'over'
    ? overFinding(gap)
    : gap.kind === 'stale'
      ? staleFinding(gap)
      : unscannedFinding();

const treeSites = async (root: string): Promise<readonly BusPublishSite[]> =>
  (await readTestSources(root)).flatMap((file) => scanBusPublishes(file.path, file.text));

const PROBE: SiteProbe<BusPublishSite> = { rescan: scanBusPublishes, line: (site) => site.line };

export const busPublishGaps = async (root: string): Promise<readonly BusPublishGap[]> =>
  newSitesFirst(root, ratchetGaps(await treeSites(root), BUS_SUBSCRIBED_PINS, true), PROBE);

/** What this repo contributes to `x verify`'s `errors` step. */
export const busPublishFindings = async (root: string): Promise<readonly Finding[]> =>
  (await busPublishGaps(root)).map(busPublishFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: PINS_FILE,
    pins: BUS_SUBSCRIBED_PINS,
    sites: treeSites,
    findingFor: busPublishFindingFor,
    probe: PROBE,
    clean: 'no live test publishes before an awaited subscription confirmation',
  });
}
