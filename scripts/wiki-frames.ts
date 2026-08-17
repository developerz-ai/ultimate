#!/usr/bin/env bun
// Enforce, as a gate step, that `wiki/Realtime.md` and the wire protocol still name the same
// frames. `FRAME_KINDS` in `packages/realtime/src/sync-protocol.ts` is the wire; the page is the
// only public description of it, and nothing cross-referenced the two — so renaming a frame left
// the published protocol documentation describing a frame that no longer exists. Runs on
// `x verify`'s `manifest` step, beside the other "a committed file still describes the code" rules.
//
// TWO DIRECTIONS, DELIBERATELY UNEQUAL, because frame names are ordinary English words and error
// codes are not:
//   source -> page  a FLOOR. The kind must appear as a word somewhere on the page. It catches the
//                   case that matters — a frame added or renamed and never documented, whose new
//                   name appears nowhere — and it cannot catch a new frame called `update`.
//   page -> source  PRECISE. A backticked token immediately followed by "frame" is the page
//                   naming a frame, and it must be one that exists.
//
//   bun run scripts/wiki-frames.ts [--json]

import { FRAME_KINDS } from '@ultimat3/realtime';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export const FRAMES_PAGE = 'wiki/Realtime.md';
export const PROTOCOL_FILE = 'packages/realtime/src/sync-protocol.ts';

/** `undocumented`: the wire has a frame the page never names. `unknown`: the page has one the wire does not. */
export type FrameDocGapKind = 'undocumented' | 'unknown';

export interface FrameDocGap {
  readonly kind: FrameDocGapKind;
  readonly frame: string;
}

export interface FrameDocInput {
  /** `FRAME_KINDS`, whole — the wire's own list, never a copy of it. */
  readonly kinds: readonly string[];
  /** `wiki/Realtime.md`, verbatim. */
  readonly page: string;
}

/** `` `subscribe` frame ``, `` `reconnect` frames `` — the page naming a frame, unambiguously. */
const NAMED_FRAME = /`([a-z][a-z0-9-]*)` frames?\b/g;

/** Pure, so the negative case is a fixture rather than an edit to a published page. */
export function checkFrameDocs(input: FrameDocInput): readonly FrameDocGap[] {
  // Collapsed, because a `` `subscribe` frame `` that wraps across two lines is still one phrase.
  const page = input.page.replace(/\s+/g, ' ');
  const gaps: FrameDocGap[] = [];
  for (const kind of input.kinds) {
    // Every `FrameKind` is a lowercase identifier, so the name carries no regex metacharacter.
    if (new RegExp(`\\b${kind}\\b`, 'i').test(page)) continue;
    gaps.push({ kind: 'undocumented', frame: kind });
  }
  const known = new Set(input.kinds);
  for (const match of page.matchAll(NAMED_FRAME)) {
    const frame = match[1] ?? '';
    if (known.has(frame)) continue;
    gaps.push({ kind: 'unknown', frame });
  }
  return gaps;
}

const undocumentedFinding = (gap: FrameDocGap): Finding => ({
  code: 'X_FRAME_DOCS_STALE',
  cause: `${PROTOCOL_FILE} sends a "${gap.frame}" frame and ${FRAMES_PAGE} never names it, so the only public description of the wire protocol is missing a frame clients receive`,
  fix: `document the ${gap.frame} frame in ${FRAMES_PAGE} — one row of the "Inbound frame order" table, or a sentence naming \`${gap.frame}\``,
  at: FRAMES_PAGE,
});

const unknownFinding = (gap: FrameDocGap): Finding => ({
  code: 'X_FRAME_DOCS_STALE',
  cause: `${FRAMES_PAGE} names a \`${gap.frame}\` frame and FRAME_KINDS has no such kind, so the published protocol documents a frame no node sends`,
  fix: `rename \`${gap.frame}\` in ${FRAMES_PAGE} to the kind that replaced it (FRAME_KINDS in ${PROTOCOL_FILE} is the list), or delete the sentence`,
  at: FRAMES_PAGE,
});

const FINDINGS: Readonly<Record<FrameDocGapKind, (gap: FrameDocGap) => Finding>> = {
  undocumented: undocumentedFinding,
  unknown: unknownFinding,
};

export const frameDocGapFindingFor = (gap: FrameDocGap): Finding => FINDINGS[gap.kind](gap);

/**
 * Read the page, then check it. The one impure step. A root with no such page is not this check's
 * problem — the host checks run against synthetic trees in `scripts/verify.test.ts`.
 */
export async function frameDocGaps(root: string): Promise<readonly FrameDocGap[]> {
  const page = Bun.file(`${root}/${FRAMES_PAGE}`);
  if (!(await page.exists())) return [];
  return checkFrameDocs({ kinds: FRAME_KINDS, page: await page.text() });
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export const frameDocFindings = async (root: string): Promise<readonly Finding[]> =>
  (await frameDocGaps(root)).map(frameDocGapFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const gaps = await frameDocGaps(repoRoot());
  report(
    {
      ok: gaps.length === 0,
      script: 'wiki-frames',
      summary:
        gaps.length === 0
          ? `${FRAME_KINDS.length} frame kinds, every one named by ${FRAMES_PAGE} and no others`
          : `${gaps.length} frame(s) where ${FRAMES_PAGE} and the wire protocol disagree`,
      findings: gaps.map(frameDocGapFindingFor),
    },
    args.json,
  );
}
