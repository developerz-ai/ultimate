/**
 * Which period an instant falls in, for a meter: its start and its end, in UTC. UTC and never an
 * ambient zone — every replica must compute the same boundary for the same instant, or two pods
 * count one tenant's day against two different rows. The stored key names the zone (`day@UTC`),
 * so a zone-aware period added later is a new counter, never a reinterpreted one.
 */

import type { MeterPeriod } from './meter';

export interface MeterWindow {
  readonly startMs: number;
  readonly endMs: number;
}

const HOUR_MS = 3_600_000;

export function meterWindow(period: MeterPeriod, nowMs: number): MeterWindow {
  if (period === 'hour') {
    const startMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    return { startMs, endMs: startMs + HOUR_MS };
  }
  const at = new Date(nowMs);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  if (period === 'day') {
    const day = at.getUTCDate();
    return { startMs: Date.UTC(year, month, day), endMs: Date.UTC(year, month, day + 1) };
  }
  // `Date.UTC` normalises month 12 to January of the next year, so December needs no branch.
  return { startMs: Date.UTC(year, month, 1), endMs: Date.UTC(year, month + 1, 1) };
}

/** The period half of the stored key — the zone spelled out so it can never be assumed. */
export const meterPeriodKey = (period: MeterPeriod): string => `${period}@UTC`;
