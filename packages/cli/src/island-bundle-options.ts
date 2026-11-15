// What a caller may ask of `buildIslands`: one island, the split, the cache, the realtime answer,
// Solid as a vendor, and a coverage build. Split from `island-bundle.ts`, which builds.

export interface BuildIslandsOptions {
  /**
   * Build ONE island, named app-root-relative — the whole option surface. A test that mounts a
   * single island otherwise pays every OTHER island's Babel pass and `Bun.build` on every file,
   * and the reference app is the one that feels it.
   *
   * Optional, and it must stay optional: `buildIslands` is on `@ultimat3/cli`'s public surface and
   * `@ultimat3/testing`'s `IslandBuilder` satisfies it STRUCTURALLY as `(root: string) => …`, which
   * is what keeps the `cli -> testing` edge pointing the one legal way.
   */
  readonly only?: string;
  /**
   * One split build over every island (`app.config.ts`'s `islands.sharedChunks`, off by default),
   * or one build per route group (`island-groups.ts`). Passed, it overrides the app's config — the
   * seam a test asks both questions of one fixture through.
   */
  readonly sharedChunks?: boolean;
  /**
   * Reuse a group's output from `.x/cache/islands/` while every file it read is unchanged
   * (`island-group-cache.ts`) — on by default. `false` is the seam a determinism test builds
   * through: a reused byte string proves nothing about the bundler that emitted it.
   */
  readonly reuse?: boolean;
  /**
   * Whether the app persists records (`appPersistsRecords`), asked only by a group one of whose
   * islands reaches realtime, and once per call. `x dev` builds islands BESIDE the app load
   * (`buildGeneration`), so it passes the answer the registry gives once the load settles; read
   * any earlier it is the empty registry's `undefined`, and every reader islands is held. Absent,
   * the registry is read as it stands: the caller loaded the app first.
   */
  readonly persists?: () => Promise<boolean | undefined>;
  /**
   * Solid as ONE shared output every island imports (`island-vendor.ts`), off by default. Measured
   * As of 2026-11-12 (Bun 1.4.4, solid-js 1.9.17): each island inlines a tree-shaken ~14 kB of
   * Solid, the whole vendor is 48,083 B, so every Solid route of the three tracked apps grew
   * +33,572…+38,769 B with it on; it pays only where a page renders four or more Solid islands
   * that are built apart.
   */
  readonly vendorSolid?: boolean;
  /**
   * A build for `mountIsland` under a coverage run: whitespace kept, Babel's lines kept, the map on
   * every chunk — so the chunk's lines count for the island's source. Never cached, never shipped.
   */
  readonly coverage?: boolean;
}
