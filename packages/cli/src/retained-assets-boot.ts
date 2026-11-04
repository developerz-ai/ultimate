// The web role's boot half of `assets.retain`: read the section the `*Of(config)` way, refuse a
// disk the app never declared, publish every hashed file this build serves — before the role
// binds, so before `/readyz` can say ready — and hand back the reader the asset routes miss into.

import type { AppConfig, AssetsRetainConfig } from '@ultimat3/core';
import { ConfigInvalidError, renderFixLiteral } from '@ultimat3/core';
import type { Storage } from '@ultimat3/storage';
import type { IslandBundle } from './island-bundle';
import type { BuildAsset, PublishReport, RetainLog } from './retained-assets';
import { publishBuildAssets } from './retained-assets';
import { retainedPrefix } from './retained-assets-layout';
import type { RetainedAssets } from './retained-assets-read';
import { retainedAssets } from './retained-assets-read';
import { siteAssetTable } from './site-assets';
import type { StyleBundle } from './style-bundle';
import type { FrameworkScript } from './worker-bundle';

/** `assets.retain`, or `undefined` — absent is today's behaviour: each pod serves what it built. */
export function retainOf(config: AppConfig | undefined): AssetsRetainConfig | undefined {
  return config?.assets.retain;
}

/** What this build serves at a content-addressed URL: the whole of what an old tab can ask for. */
export interface BuiltSurface {
  readonly root: string;
  readonly islands: IslandBundle;
  readonly styles: StyleBundle;
  readonly scripts: readonly FrameworkScript[];
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Every hashed file, once per URL, in route order: styles, islands, scripts, site assets. */
export function buildAssetsOf(surface: BuiltSurface): readonly BuildAsset[] {
  const assets: BuildAsset[] = [
    ...surface.styles.chunks.map((chunk) => ({
      url: chunk.url,
      contentType: 'text/css; charset=utf-8',
      body: encode(chunk.css),
    })),
    ...[...surface.islands.chunks, ...surface.islands.shared].map((chunk) => ({
      url: chunk.url,
      contentType: 'text/javascript',
      body: encode(chunk.code),
    })),
    ...surface.scripts.map((script) => ({
      url: script.url,
      contentType: 'text/javascript',
      body: encode(script.code),
    })),
    // A `Bun.file`, so a disk refuses one past its ceiling by size without reading it.
    ...siteAssetTable(surface.root)
      .all()
      .map((asset) => ({
        url: asset.url,
        contentType: asset.contentType,
        body: Bun.file(asset.file),
      })),
  ];
  return [...new Map(assets.map((asset) => [asset.url, asset] as const)).values()];
}

export interface RetainBootInput extends BuiltSurface {
  readonly config: AppConfig | undefined;
  /** The disks the app's routes read (`servedStorage`) — `retain.disk` must be one of them. */
  readonly storage: Storage;
  readonly buildId: string;
  /** `resolveEnvironment` of the boot's env: half of the scope, with `config.name`. */
  readonly environment: string;
  readonly log?: RetainLog | undefined;
  /** Test seam; `RETAIN_PUBLISH_DEADLINE_MS` otherwise. */
  readonly deadlineMs?: number | undefined;
}

export interface RetainedBoot {
  /** What the asset routes read a miss through — `withRetainedAssets(routes, reader)`. */
  readonly reader: RetainedAssets;
  readonly report: PublishReport;
}

/**
 * `undefined` when the app declared no window. A misnamed disk refuses the boot: it is the app's
 * config, wrong, and every pod of the deploy would otherwise run without the window it asked for.
 * A disk that refuses a write does NOT: `publishBuildAssets` logs it and the pod serves, reading
 * earlier builds' files all the same. The scope is `config.name` and the environment, so staging
 * and production on one bucket never sweep or serve each other.
 */
export async function retainBuildAssets(input: RetainBootInput): Promise<RetainedBoot | undefined> {
  const retain = retainOf(input.config);
  if (input.config === undefined || retain === undefined) return undefined;
  const names = input.storage.diskNames;
  if (!names.includes(retain.disk)) {
    throw new ConfigInvalidError({
      cause: `assets.retain.disk is "${retain.disk}" but the app's disks are: ${names.join(', ')}`,
      fix: `assets: { retain: { disk: ${renderFixLiteral(names[0], "'<disk>'")}, builds: ${String(retain.builds)} } }   # in app.config.ts; the declared disks: ${names.join(', ')}`,
      meta: { key: 'assets.retain.disk' },
    });
  }
  const scope = {
    disk: input.storage.disk(retain.disk),
    prefix: retainedPrefix(input.config.name, input.environment),
  };
  const report = await publishBuildAssets({
    ...scope,
    diskName: retain.disk,
    buildId: input.buildId,
    builds: retain.builds,
    assets: buildAssetsOf(input),
    ...(input.log === undefined ? {} : { log: input.log }),
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
  });
  return { reader: retainedAssets(scope), report };
}
