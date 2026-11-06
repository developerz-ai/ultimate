// Single responsibility: turning a held failure into a stored bundle, at `reportError` — the one
// moment the failure has its group (`errorFingerprint` over the very report the monitor gets), so
// `x_failures` and `x_error_groups` are keyed alike. Bounded per fingerprint per hour, capped in
// bytes, and never awaited by the response: a store that refuses is a log line.

import { errorFingerprint } from './error-fingerprint';
import type { ErrorReport } from './error-reporter';
import type { FailureBundle, HeldFailure } from './failure-capture';
import {
  failureCaptureLimits,
  failureStoreRefused,
  installedFailureStore,
  takeHeldFailure,
} from './failure-capture';
import { uuidV7 } from './ids';

const HOUR_MS = 60 * 60 * 1000;
/** Fingerprints remembered for the hourly bound; past it the oldest window is forgotten. */
const MAX_WINDOWS = 1000;

const windows = new Map<string, { start: number; count: number }>();
const pending = new Set<Promise<void>>();

/** Whether one more bundle of this group fits this hour. Per process: a fleet stores N× the bound. */
function admitted(fingerprint: string, at: number): boolean {
  const window = windows.get(fingerprint);
  if (window === undefined || at - window.start >= HOUR_MS) {
    windows.delete(fingerprint);
    if (windows.size >= MAX_WINDOWS) windows.delete(windows.keys().next().value ?? '');
    windows.set(fingerprint, { start: at, count: 1 });
    return true;
  }
  if (window.count >= failureCaptureLimits().perHour) return false;
  window.count += 1;
  return true;
}

const sizeOf = (bundle: FailureBundle): number =>
  new TextEncoder().encode(JSON.stringify(bundle)).length;

/** Rows dropped from the end, then the flags, until the bundle fits `maxBytes`. Never the input. */
function capped(bundle: FailureBundle): FailureBundle {
  const max = failureCaptureLimits().maxBytes;
  if (sizeOf(bundle) <= max) return bundle;
  const reads = [...bundle.reads];
  let next: FailureBundle = bundle;
  while (reads.length > 0 && sizeOf(next) > max) {
    reads.pop();
    next = { ...bundle, reads: [...reads], truncated: true };
  }
  return sizeOf(next) <= max ? next : { ...next, flags: {}, truncated: true };
}

function bundleOf(held: HeldFailure, report: ErrorReport): FailureBundle {
  return capped({
    ...held,
    id: uuidV7(),
    fingerprint: errorFingerprint(report),
    code: report.code,
    operation: report.scope.operation ?? null,
    build: held.build ?? report.release,
    at: held.at === 0 ? report.at : held.at,
  });
}

/**
 * Called by `reportError` with every report, before the reporter sees it. A value nothing held
 * costs one `WeakMap` read. Total: it never throws, and the save is never awaited here.
 */
export function releaseHeldFailure(error: unknown, report: () => ErrorReport): void {
  const store = installedFailureStore();
  const held = takeHeldFailure(error);
  if (store === null || held === undefined) return;
  try {
    const bundle = bundleOf(held, report());
    if (!admitted(bundle.fingerprint, bundle.at)) return;
    const saving = store.save(bundle).catch(failureStoreRefused);
    pending.add(saving);
    void saving.finally(() => pending.delete(saving));
  } catch (failure) {
    failureStoreRefused(failure);
  }
}

/** Every save in flight, settled: a drain hook, and a test that reads the store next. */
export async function settleFailureCaptures(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/** Test-only: forget the hourly windows. */
export function resetFailureCaptureWindows(): void {
  windows.clear();
}
