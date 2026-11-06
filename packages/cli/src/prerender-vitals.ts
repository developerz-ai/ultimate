// What the build adds for real-user timings (`clientErrors.vitals`): the head each surface's
// documents carry and the script's bytes, so the budgets step weighs a page as it is SERVED. Off,
// or a surface not listed, adds nothing — and a page that carries nothing is charged nothing.

import type { ClientVitalsConfig } from '@ultimat3/core';
import {
  CLIENT_VITALS_PATH,
  CLIENT_VITALS_SCRIPT_PATH,
  clientVitalsHead,
  clientVitalsScript,
} from './client-vitals-script';

export interface VitalsBuild {
  /** For an `app/` document weighed as served. Absent unless `app` is listed. */
  readonly appHead?: string;
  /** For a `site/` document, exported and weighed. Absent unless `site` is listed. */
  readonly siteHead?: string;
  /** The bytes behind the head, keyed by the URL a document names. Absent when off. */
  readonly script?: { readonly url: string; readonly code: string };
}

export function vitalsBuild(config: ClientVitalsConfig | undefined): VitalsBuild {
  if (config?.enabled !== true) return {};
  const head = clientVitalsHead();
  return {
    ...(config.surfaces.includes('app') ? { appHead: head } : {}),
    ...(config.surfaces.includes('site') ? { siteHead: head } : {}),
    script: { url: CLIENT_VITALS_SCRIPT_PATH, code: clientVitalsScript(config.sampleRate) },
  };
}

/**
 * A `site/` page exported with the script names a beacon route only a served process answers:
 * on a static host the timings go nowhere. Said, never refused — the same export served by the
 * container does land them, and the bytes are charged either way.
 */
export function clientVitalsStaticWarning(build: VitalsBuild): string[] {
  if (build.siteHead === undefined) return [];
  return [
    `clientErrors.vitals.surfaces lists site, and a static host serves no ${CLIENT_VITALS_PATH} route — exported site/ pages carry ${CLIENT_VITALS_SCRIPT_PATH}, and their beacons land only where the app is served (x dev, or the container)`,
  ];
}
