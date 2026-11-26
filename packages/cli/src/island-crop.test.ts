// `x shot --island`'s crop rectangle, pure: the margin every side, the clamp to the page, and the
// frame grown to every open popup. Split from `island-shot.test.ts`, which drives whole runs.

import { describe, expect, test } from 'bun:test';
import { clipFor, ISLAND_CROP_MARGIN_PX } from './island-capture';
import { readinessProbe } from './island-harness-script';
import type { IslandReadiness } from './island-verdict';

const READY: IslandReadiness = {
  harness: true,
  ready: true,
  unstubbed: [],
  sockets: [],
  attached: true,
  mounted: true,
  failed: null,
  filled: true,
  box: { x: 8, y: 8, width: 420, height: 260 },
  scroll: { x: 0, y: 0 },
  overflow: { x: false, y: false },
  page: { width: 1280, height: 2000 },
};

/**
 * The crop was the readiness box EXACTLY, and a pixel-tight rectangle shaves off everything a
 * component paints outside its border box — a `box-shadow`, an outline, a focus ring, a hairline
 * border on a subpixel. The reviewer then reads a component with no elevation as flat, which is a
 * change the component never made.
 *
 * Every case fails on a margin of 0, which is the code this replaced.
 */
describe('unit · the crop carries a margin, and the margin is clamped to the page', () => {
  const clipAt = (
    box: IslandReadiness['box'],
    page: IslandReadiness['page'] = { width: 1280, height: 2000 },
  ) => clipFor({ ...READY, box, scroll: { x: 0, y: 0 }, page }, ISLAND_CROP_MARGIN_PX);

  test('the frame is the component grown by one margin on every side', () => {
    expect(clipAt({ x: 100, y: 100, width: 200, height: 120 })).toEqual({
      x: 100 - ISLAND_CROP_MARGIN_PX,
      y: 100 - ISLAND_CROP_MARGIN_PX,
      width: 200 + 2 * ISLAND_CROP_MARGIN_PX,
      height: 120 + 2 * ISLAND_CROP_MARGIN_PX,
    });
  });

  // A clip starting at -8 asks CDP for coordinates no page content is at, and what comes back is a
  // blank band a reviewer reads as the component's own whitespace.
  test('a component at the page origin never asks for a negative coordinate', () => {
    expect(clipAt({ x: 0, y: 0, width: 200, height: 120 })).toEqual({
      x: 0,
      y: 0,
      width: 208,
      height: 128,
    });
  });

  test('a component at the far edge never runs past the document', () => {
    expect(clipAt({ x: 1080, y: 1880, width: 200, height: 120 })).toEqual({
      x: 1072,
      y: 1872,
      width: 208,
      height: 128,
    });
  });

  /**
   * The invariant that survives a page whose own extent is smaller than the box it reports — a
   * transform, a fixed element, a document read mid-layout. A clamp that could shrink the frame
   * would crop the component this run is OF, which is worse than no margin at all.
   */
  test('the margin may only make the frame bigger, never smaller than the component', () => {
    const clip = clipAt({ x: 0, y: 0, width: 400, height: 400 }, { width: 10, height: 10 });
    expect([clip.width, clip.height]).toEqual([400, 400]);
  });
});

/**
 * The crop was the island's own box, so an OPEN popup — a combobox's listbox, a menu, a popover
 * portalled to `<body>` — was cut at the trigger's bottom edge, and the state the file declared
 * (`open`, `filtered`) photographed as a closed input. The frame is the union now.
 */
describe('unit · the crop covers the island AND its open popups', () => {
  test('a listbox below the trigger is inside the frame', () => {
    const clip = clipFor(
      {
        ...READY,
        box: { x: 100, y: 100, width: 200, height: 40 },
        frame: { x: 100, y: 100, width: 240, height: 300 },
      },
      ISLAND_CROP_MARGIN_PX,
    );
    expect(clip).toEqual({
      x: 100 - ISLAND_CROP_MARGIN_PX,
      y: 100 - ISLAND_CROP_MARGIN_PX,
      width: 240 + 2 * ISLAND_CROP_MARGIN_PX,
      height: 300 + 2 * ISLAND_CROP_MARGIN_PX,
    });
  });

  test('the probe measures the popups the page shows, by role and by open popover', () => {
    const probe = readinessProbe('[data-x-island]');
    for (const popup of ['[role=listbox]', '[role=menu]', '[role=dialog]', ':popover-open']) {
      expect(probe).toContain(popup);
    }
    expect(probe).toContain('frame:');
  });
});
