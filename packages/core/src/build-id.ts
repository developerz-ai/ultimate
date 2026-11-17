// Single responsibility: the build id this process serves, as the BOOT resolved it — `BUILD_ID`
// when stamped and non-empty, else the manifest's content hash (cli's `serve-boot.ts`/`dev-boot.ts`).
// Core never reads `BUILD_ID` itself: its `?? 'dev'` kept the `''` an unstamped image's Dockerfile
// writes, so `/healthz` and a worker's `ctx.buildId` said `""` while `x-ultimate-build` named the hash.

import { adapterSlot } from './adapter-slot';

/** Outside any boot — a bare script, a test — there is no build to name. */
const UNBOOTED_BUILD_ID = 'dev';

const builds = /* @__PURE__ */ adapterSlot<string>(() => UNBOOTED_BUILD_ID);

/**
 * The boot's one hand-off of the id it resolved — on `@ultimat3/core/adapter` only, as every
 * installer is. Answers the release that removes THIS install and no other, in any order.
 */
export function installBuildId(id: string): () => void {
  return builds.install(id);
}

/** The id `ctxOf()`, the health report and `x-ultimate-build` agree on; `'dev'` when none installed. */
export function installedBuildId(): string {
  return builds.current();
}
