// A bottom sheet's drag, as numbers: how far the panel follows the finger, and where it settles
// on release — `half`, `full`, or closed. Pure, so the browser test and the unit test agree on the
// thresholds, and the component only moves a custom property.

export type DrawerSnap = 'half' | 'full';
export type DrawerRelease = DrawerSnap | 'close';

/** Past this share of the sheet's height, a release moves to the next snap. */
export const SNAP_SHARE = 0.2;
/** Past this share downwards, a release closes the sheet. */
export const CLOSE_SHARE = 0.5;
/** An upward drag past the top snap follows at a third: resistance, not a hard stop. */
export const OVER_DRAG_RESISTANCE = 3;

/**
 * The panel's offset for a finger `delta` px below where it went down (negative is up). Down
 * follows 1:1; up follows at a third, and not at all from `full`, where there is no further snap.
 */
export function dragOffset(delta: number, from: DrawerSnap): number {
  if (!Number.isFinite(delta)) return 0;
  if (delta >= 0) return delta;
  return from === 'full' ? 0 : delta / OVER_DRAG_RESISTANCE;
}

/** Where a sheet `height` px tall, dragged `delta` px from `from`, settles on release. */
export function releaseSnap(delta: number, height: number, from: DrawerSnap): DrawerRelease {
  if (!Number.isFinite(delta) || !(height > 0)) return from;
  const share = delta / height;
  if (share > CLOSE_SHARE) return 'close';
  if (from === 'full' && share > SNAP_SHARE) return 'half';
  if (from === 'half' && share < -SNAP_SHARE) return 'full';
  return from;
}
