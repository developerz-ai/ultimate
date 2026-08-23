// The crop rectangle a capture may name, and the four shapes of one that would answer a blank
// picture instead of a refusal. Its own module because the rule belongs to EVERY driver
// identically — a check per driver is three chances to disagree — and because `target.ts` is a
// port declaration, which is not a place decisions live.

import { captureClipEmpty, captureClipOnPdf, captureFramingConflict } from './error-throws';

/**
 * CSS pixels in the page's own coordinate space, top-left origin — the space
 * `getBoundingClientRect()` answers in, which is where a caller's rectangle comes from.
 *
 * No `scale`. CDP's clip has one and nothing here would read it, which is this repo's most
 * repeated defect (`scripts/config-readers.ts`); a device pixel ratio belongs to the launch, not
 * to one capture.
 */
export interface CaptureClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What both capture verbs are framed by. `CaptureOptions` and `CaptureRequest` are this, named. */
export interface CaptureFraming {
  readonly fullPage?: boolean | undefined;
  readonly clip?: CaptureClip | undefined;
}

const finite = (value: number): boolean => Number.isFinite(value);

/**
 * Refuse a framing no driver can honour, BEFORE any driver sees it.
 *
 * What is deliberately NOT checked: whether the rectangle is inside the viewport. This package
 * neither sets nor reads a viewport — nothing in `src/` mentions one — so the answer would cost a
 * round trip into the page, and it would be the WRONG answer: a component below the fold is
 * exactly what a component crop is for, and every current build captures beyond the viewport. A
 * rectangle entirely in negative space needs no browser to refuse and is the half that is real.
 */
export function assertCaptureFraming(kind: 'screenshot' | 'pdf', framing: CaptureFraming): void {
  const clip = framing.clip;
  if (clip === undefined) return;
  // A PDF is paginated by the print engine; CDP's `Page.printToPDF` has no clip to forward one to.
  // Refused rather than dropped: a whole-page PDF returned to a caller who asked for one component
  // is the same silent wrong answer the fullPage/clip pair produces.
  if (kind === 'pdf') throw captureClipOnPdf(clip);
  // `=== true` and not truthiness: `fullPage: false` beside a clip is a caller spelling out the
  // default, which is not a conflict. Only the pair that CDP resolves silently is refused.
  if (framing.fullPage === true) throw captureFramingConflict(clip);
  if (!finite(clip.x) || !finite(clip.y) || !finite(clip.width) || !finite(clip.height)) {
    throw captureClipEmpty(clip, 'is not four finite numbers');
  }
  if (clip.width <= 0 || clip.height <= 0) throw captureClipEmpty(clip, 'has no area');
  if (clip.x + clip.width <= 0 || clip.y + clip.height <= 0) {
    throw captureClipEmpty(clip, 'lies entirely in negative coordinates, where no page content is');
  }
}
