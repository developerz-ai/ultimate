// How the build weighs an app/ page it renders only to measure: as the document a request is
// SERVED — the sync head and page boot both boots compose (`pageSync`), and the runtime chunk that
// boot makes unfetched. An unscoped render measured a runtime chunk no scoped page downloads and
// never the boot every one of them does, so `/feed` and `/runs` were budgets about nothing (#505).

import type { ClientSyncHead } from '@ultimat3/render';
import { loadAppConfig } from './app-config-load';
import type { MeasureOptions } from './budgets';
import type { IslandBundle } from './island-bundle';
import { isRuntimeChunk } from './island-runtime';
import { pageSync } from './page-sync';
import { realtimeConfigOf } from './runtime-realtime';
import { PAGE_BOOT_BASE_PATH } from './worker-bundle';

/** What a served-document measurement adds: to the document's options, and to the measurer's. */
export interface ServedMeasure {
  readonly document: {
    readonly sync?: ClientSyncHead;
    readonly persisted?: () => readonly string[];
  };
  readonly measure: MeasureOptions;
}

/**
 * `realtime.enabled: false` serves no sync head and no boot (`pageSync`), and then the measurement
 * adds nothing: such a page's realtime islands load the runtime chunk, and are charged for it.
 */
export async function servedMeasure(
  root: string,
  buildId: string,
  islands: IslandBundle,
): Promise<ServedMeasure> {
  const sync = await pageSync(
    root,
    process.env,
    buildId,
    realtimeConfigOf(await loadAppConfig(root)),
  );
  return {
    document: {
      ...(sync.head === undefined ? {} : { sync: sync.head }),
      persisted: sync.persisted,
    },
    measure: {
      served: new Map(sync.scripts.map((script) => [script.url, script.code])),
      boot: {
        prefix: `${PAGE_BOOT_BASE_PATH}/`,
        supplies: new Set(islands.shared.map((one) => one.url).filter(isRuntimeChunk)),
      },
    },
  };
}
