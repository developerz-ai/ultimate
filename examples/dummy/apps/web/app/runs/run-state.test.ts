// The console's reading of a run: the order it shows, the duplicates it drops and the state it
// names. The failure this exists against is the one the feature was specified around — a first
// event numbered 0 that a `seq > 0` reader never shows.
import { expect, unitTest } from '@ultimat3/testing';
import type { RunEventRow } from './run-state';
import {
  CONSOLE_STATES,
  consoleState,
  isLive,
  LIVE_RUN_EVENTS,
  orderedEvents,
  runUsage,
  waitingPrompt,
} from './run-state';

const RUN = '00000000-0000-4000-8000-0000000000b1';

const event = (seq: number, kind: RunEventRow['kind'], prompt: number | null = null) => ({
  id: `event-${seq}-${kind}`,
  runId: RUN,
  seq,
  kind,
  at: '2026-10-01T09:00:00.000Z',
  message: '',
  prompt,
  usage: null,
});

const USED = {
  browserMs: 4200,
  navigations: 2,
  httpRequests: 1,
  bytesIn: 2048,
  promptsAnswered: 1,
};
const used = (seq: number): RunEventRow => ({ ...event(seq, 'usage'), usage: USED });

unitTest('events are shown in seq order whatever order they arrived in', () => {
  const shown = orderedEvents([event(3, 'navigated'), event(1, 'prompt', 1), event(2, 'answered')]);
  expect(shown.map((row) => row.seq)).toEqual([1, 2, 3]);
});

unitTest('a redelivered seq is one event, and the first copy wins', () => {
  const shown = orderedEvents([event(1, 'prompt', 1), event(1, 'failed'), event(2, 'answered')]);
  expect(shown.map((row) => row.kind)).toEqual(['prompt', 'answered']);
});

unitTest('seq starts at 1: the first event is shown, and a seq of 0 is not an event', () => {
  expect(orderedEvents([event(1, 'prompt', 1)])).toHaveLength(1);
  expect(orderedEvents([event(0, 'prompt', 1)])).toEqual([]);
});

unitTest('a run is pending until its first event, then whatever its last event says', () => {
  expect(consoleState([])).toBe('pending');
  expect(consoleState([event(1, 'prompt', 1)])).toBe('awaiting');
  expect(consoleState([event(1, 'prompt', 1), event(2, 'answered')])).toBe('streaming');
  expect(consoleState([event(1, 'navigated')])).toBe('streaming');
  expect(consoleState([event(1, 'navigated'), event(2, 'extracted')])).toBe('streaming');
  expect(consoleState([event(1, 'navigated'), event(2, 'done')])).toBe('done');
  expect(consoleState([event(1, 'prompt', 1), event(2, 'failed')])).toBe('failed');
});

unitTest('every state the console names is reachable from some list of events', () => {
  const reached = new Set([
    consoleState([]),
    consoleState([event(1, 'navigated')]),
    consoleState([event(1, 'prompt', 1)]),
    consoleState([event(1, 'failed')]),
    consoleState([event(1, 'done')]),
  ]);
  expect([...reached].sort()).toEqual([...CONSOLE_STATES].sort());
});

unitTest('the waiting prompt is the last event’s, and nothing once it was answered', () => {
  expect(waitingPrompt([])).toBeNull();
  expect(waitingPrompt([event(1, 'prompt', 1)])).toBe(1);
  expect(waitingPrompt([event(1, 'prompt', 1), event(2, 'answered')])).toBeNull();
});

unitTest('what a run used is recorded after it ended, and moves no state', () => {
  const ended = [event(1, 'navigated'), event(2, 'done'), used(3)];
  expect(consoleState(ended)).toBe('done');
  expect(consoleState([event(1, 'prompt', 1), event(2, 'failed'), used(3)])).toBe('failed');
  // Not a question either: the prompt it followed is still the one waiting.
  expect(waitingPrompt([event(1, 'prompt', 1), used(2)])).toBe(1);
  expect(runUsage(ended)).toEqual(USED);
  expect(runUsage([event(1, 'done')])).toBeNull();
});

unitTest('a run can be cancelled until it ends', () => {
  expect(isLive('pending')).toBe(true);
  expect(isLive('streaming')).toBe(true);
  expect(isLive('awaiting')).toBe(true);
  expect(isLive('done')).toBe(false);
  expect(isLive('failed')).toBe(false);
});

unitTest('the console subscribes under the query’s registered name', () => {
  expect(LIVE_RUN_EVENTS).toBe('liveRunEvents');
});
