// The one table from a `--shape` name to its overlay. Typed over `NEW_SHAPES`, so a name with no
// overlay (or an overlay with no name) is a compile error rather than a shape `x new` half-writes.

import type { NewShape } from '../../new-shapes';
import { apiShape } from './api';
import { blogShape } from './blog';
import { dashboardShape } from './dashboard';
import type { ShapeOverlay } from './overlay';

export const SHAPE_OVERLAYS: { readonly [S in NewShape]: ShapeOverlay } = {
  api: apiShape,
  blog: blogShape,
  dashboard: dashboardShape,
};

export type { ShapeEdit, ShapeOverlay } from './overlay';
export { applyEdit, applyOverlay, dropCatalogKeys } from './overlay';
