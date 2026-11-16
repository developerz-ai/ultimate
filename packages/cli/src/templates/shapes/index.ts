// The one table from a `--shape` name to its overlay. Typed over `NEW_SHAPES`, so a name with no
// overlay (or an overlay with no name) is a compile error rather than a shape `x new` half-writes.

import type { NewShape } from '../../new-shapes';
import { agentShape } from './agent';
import { apiShape } from './api';
import { blogShape } from './blog';
import { contentShape } from './content';
import { dashboardShape } from './dashboard';
import { offlineShape } from './offline';
import type { ShapeOverlay } from './overlay';
import { realtimeShape } from './realtime';
import { saasShape } from './saas';

export const SHAPE_OVERLAYS: { readonly [S in NewShape]: ShapeOverlay } = {
  api: apiShape,
  blog: blogShape,
  dashboard: dashboardShape,
  saas: saasShape,
  agent: agentShape,
  realtime: realtimeShape,
  content: contentShape,
  offline: offlineShape,
};

export type { ShapeEdit, ShapeOverlay } from './overlay';
export { applyEdit, applyOverlay, dropCatalogKeys } from './overlay';
