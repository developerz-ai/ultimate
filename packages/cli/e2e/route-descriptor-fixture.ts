// One `RouteDescriptor`, built from the three fields a service worker reads and defaults for the
// eleven it does not. Its own file because `sw-artifacts.ts` takes the framework's real descriptor
// type: a partial cast would let a field the emitter starts reading arrive as `undefined` with no
// type error, which is the class of defect the `e2e` step exists to catch rather than create.

import type { OfflineStrategy, RenderMode } from '@ultimat3/core';
import type { RouteDescriptor } from '@ultimat3/render';

export interface RouteFixture {
  readonly path: string;
  readonly surface: RouteDescriptor['surface'];
  readonly mode: RenderMode;
  readonly offline: OfflineStrategy;
  readonly dynamic?: boolean;
}

export const routeDescriptor = (fixture: RouteFixture): RouteDescriptor => ({
  path: fixture.path,
  file: `apps/web/${fixture.surface}${fixture.path === '/' ? '' : fixture.path}/page.tsx`,
  surface: fixture.surface,
  mode: fixture.mode,
  offline: fixture.offline,
  hydrate: 'never',
  revalidateTags: [],
  revalidateTtl: null,
  prerenderable: fixture.mode === 'static',
  dynamic: fixture.dynamic ?? false,
  hasPolicy: false,
  islands: [],
  budgetJs: null,
  budgetLcp: null,
});
