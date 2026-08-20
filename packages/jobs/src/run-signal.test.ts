// What `AbortSignal.any` cannot do: be undone. A worker composes the caller's signal into every
// job it runs, so a caller signal that lives as long as the process — an app wiring its own
// shutdown controller into `WorkerOptions.context()` — collected one composite per job run.

import { describe, expect, test } from 'bun:test';
import { createRunSignal } from './run-signal';

describe('the signal one run is cancelled by', () => {
  test('follows every source it was given', () => {
    const caller = new AbortController();
    const lease = new AbortController();
    const run = createRunSignal([caller.signal, lease.signal]);

    expect(run.signal.aborted).toBe(false);
    lease.abort(new Error('lease lost'));
    expect(run.signal.aborted).toBe(true);
    expect((run.signal.reason as Error).message).toBe('lease lost');
  });

  test('a source already aborted aborts the run at composition, with its own reason', () => {
    const caller = new AbortController();
    caller.abort(new Error('caller gone'));
    const run = createRunSignal([caller.signal, undefined]);

    expect(run.signal.aborted).toBe(true);
    expect((run.signal.reason as Error).message).toBe('caller gone');
  });

  test('dispose detaches from the sources, so a run that ended holds nothing of theirs', () => {
    const caller = new AbortController();
    let listeners = 0;
    const add = caller.signal.addEventListener.bind(caller.signal);
    const remove = caller.signal.removeEventListener.bind(caller.signal);
    // The count is the assertion: `AbortSignal.any` registers nothing here, which is exactly why
    // there was nothing to hand back — the composite hung off the caller's signal instead.
    // Annotated, not inferred: `addEventListener` is OVERLOADED on `AbortSignal`, and TypeScript
    // gives an assignment target with overloads no contextual parameter types — so every parameter
    // here was an implicit `any` that nothing checked against the method it replaces.
    caller.signal.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ): void => {
      listeners += 1;
      add(type, listener, options);
    };
    caller.signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: EventListenerOptions | boolean,
    ): void => {
      listeners -= 1;
      remove(type, listener, options);
    };

    const run = createRunSignal([caller.signal]);
    expect(listeners).toBe(1);

    run.dispose();
    expect(listeners).toBe(0);
    caller.abort(new Error('after the run'));
    expect(run.signal.aborted).toBe(false);
  });

  test('the worker can cancel the run itself, and the first reason wins', () => {
    const run = createRunSignal([]);
    run.abort(new Error('slot lost'));
    run.abort(new Error('second'));

    expect((run.signal.reason as Error).message).toBe('slot lost');
  });
});
