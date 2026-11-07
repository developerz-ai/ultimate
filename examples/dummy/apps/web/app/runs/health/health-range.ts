/**
 * The window `/runs/health` reads: one of three presets ending now, or a custom `from`/`to` in the
 * member's zone, held in the URL by `timeRangeUrl` so a window survives reload, share and Back.
 * The preset list and its words are this app's (axiom 8); the reading rule is the design system's.
 */

import type { TimeRangeUrl } from '@ultimat3/ui';
import { timeRangeUrl } from '@ultimat3/ui';

const DAY_SECONDS = 86_400;

/** The presets the page offers, shortest first. A week is the default: a strip's worth of runs. */
export const HEALTH_RANGES = [
  { id: 'day', seconds: DAY_SECONDS },
  { id: 'week', seconds: 7 * DAY_SECONDS },
  { id: 'month', seconds: 30 * DAY_SECONDS },
] as const;

export type HealthRangeId = (typeof HEALTH_RANGES)[number]['id'];

export const DEFAULT_HEALTH_RANGE: HealthRangeId = 'week';

export interface HealthRangeOptions {
  /** The member's IANA zone: a custom window's wall-clock times are in it. */
  readonly timeZone: string;
  /** The request's clock, read once in `load` and handed to the page, so both read one window. */
  readonly now: Date;
  /** Each preset's translated label; `load` needs only the window, and passes the id. */
  readonly label: (id: HealthRangeId) => string;
}

/** The window the URL asks for — the default week when it asks for none, or for one it cannot. */
export function healthRange(url: string, options: HealthRangeOptions): TimeRangeUrl {
  return timeRangeUrl(url, {
    presets: HEALTH_RANGES.map((range) => ({
      id: range.id,
      seconds: range.seconds,
      label: options.label(range.id),
    })),
    default: DEFAULT_HEALTH_RANGE,
    timeZone: options.timeZone,
    now: options.now,
  });
}
