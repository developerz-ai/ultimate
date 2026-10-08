/**
 * What the settings island says after "Notify me": the outcome `subscribeToPush` answered, or a
 * failure of its own — a save the SERVER refused (a 5xx, an expired session) is the retry wording,
 * never the "this browser cannot" label, which would blame the device for the server's fault.
 */

import type { PushSubscribeOutcome } from '@ultimat3/pwa/client';

export interface PushLabels {
  readonly pushOn: string;
  readonly pushDenied: string;
  readonly pushUnavailable: string;
  readonly retry: string;
}

export function pushStatus(outcome: PushSubscribeOutcome | 'failed', labels: PushLabels): string {
  if (outcome === 'failed') return labels.retry;
  if (outcome.status === 'subscribed') return labels.pushOn;
  return outcome.status === 'denied' ? labels.pushDenied : labels.pushUnavailable;
}
