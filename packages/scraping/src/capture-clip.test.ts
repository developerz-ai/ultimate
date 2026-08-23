// The framing rule, asserted on the RENDERED refusal — `toJSON()` is what `--json`, a job row and
// a dead-letter record carry, and an assertion on the instance can pass while the wire shape says
// something else.

import { describe, expect, test } from 'bun:test';
import type { CaptureClip, CaptureFraming } from './capture-clip';
import { assertCaptureFraming } from './capture-clip';

const BOX: CaptureClip = { x: 12, y: 34, width: 300, height: 180 };

const refusal = (
  kind: 'screenshot' | 'pdf',
  framing: CaptureFraming,
): Record<string, unknown> | undefined => {
  try {
    assertCaptureFraming(kind, framing);
    return undefined;
  } catch (thrown) {
    return JSON.parse(JSON.stringify(thrown)) as Record<string, unknown>;
  }
};

describe('unit · a framing every driver can honour passes untouched', () => {
  test('no clip is no opinion — the shape that shipped before the clip existed', () => {
    expect(refusal('screenshot', {})).toBeUndefined();
    expect(refusal('screenshot', { fullPage: true })).toBeUndefined();
    expect(refusal('pdf', { fullPage: true })).toBeUndefined();
  });

  test('a clip alone, and a clip beside an explicit fullPage: false', () => {
    expect(refusal('screenshot', { clip: BOX })).toBeUndefined();
    expect(refusal('screenshot', { fullPage: false, clip: BOX })).toBeUndefined();
  });

  test('a rectangle BELOW THE FOLD is accepted — the component crop exists for exactly that', () => {
    // Not checked against a viewport, deliberately: this package neither sets nor reads one, and
    // the check would refuse the case the feature was built for.
    expect(
      refusal('screenshot', { clip: { x: 0, y: 9_000, width: 320, height: 200 } }),
    ).toBeUndefined();
    // Partly off the left edge is a real crop of a real element, too.
    expect(
      refusal('screenshot', { clip: { x: -10, y: 0, width: 320, height: 200 } }),
    ).toBeUndefined();
  });
});

describe('unit · a framing that would answer a blank picture is refused', () => {
  test('fullPage: true beside a clip names both, and says which to drop', () => {
    const rendered = refusal('screenshot', { fullPage: true, clip: BOX });
    expect(rendered?.['code']).toBe('X_SCRAPE_CAPTURE_INVALID');
    expect(rendered?.['cause']).toContain('300x180 at 12,34');
    expect(rendered?.['fix']).toContain('drop fullPage');
    expect(rendered?.['retry']).toBe('terminal');
    expect(rendered?.['meta']).toEqual({ clip: { ...BOX }, fullPage: true });
  });

  test('a zero or negative area is refused, never captured as an empty PNG', () => {
    for (const clip of [
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: 0 },
      { x: 0, y: 0, width: -1, height: 10 },
      { x: 0, y: 0, width: 10, height: -1 },
    ]) {
      const rendered = refusal('screenshot', { clip });
      expect(rendered?.['code'], JSON.stringify(clip)).toBe('X_SCRAPE_CAPTURE_INVALID');
      expect(rendered?.['cause'], JSON.stringify(clip)).toContain('has no area');
    }
  });

  test('a rectangle entirely in negative coordinates holds no page content', () => {
    for (const clip of [
      { x: -300, y: 0, width: 300, height: 10 },
      { x: 0, y: -10, width: 300, height: 10 },
    ]) {
      const rendered = refusal('screenshot', { clip });
      expect(rendered?.['code'], JSON.stringify(clip)).toBe('X_SCRAPE_CAPTURE_INVALID');
      expect(rendered?.['cause'], JSON.stringify(clip)).toContain('negative coordinates');
    }
  });

  test('NaN and Infinity are refused BEFORE the arithmetic, which they would pass', () => {
    // `NaN > 0` is false so the area check catches width, but `x: NaN` with a positive width
    // survives every comparison — `NaN + 300 <= 0` is false — and reaches the browser as a
    // rectangle nobody can predict. Hence the finiteness check first.
    for (const clip of [
      { x: Number.NaN, y: 0, width: 300, height: 10 },
      { x: 0, y: Number.NaN, width: 300, height: 10 },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
      { x: 0, y: 0, width: 300, height: Number.NEGATIVE_INFINITY },
    ]) {
      const rendered = refusal('screenshot', { clip });
      expect(rendered?.['code'], JSON.stringify(clip)).toBe('X_SCRAPE_CAPTURE_INVALID');
      expect(rendered?.['cause'], JSON.stringify(clip)).toContain('four finite numbers');
    }
  });

  test('a clip on a PDF is refused rather than dropped into a whole-page print', () => {
    const rendered = refusal('pdf', { clip: BOX });
    expect(rendered?.['code']).toBe('X_SCRAPE_CAPTURE_INVALID');
    expect(rendered?.['fix']).toContain('page.screenshot({ clip })');
  });
});
