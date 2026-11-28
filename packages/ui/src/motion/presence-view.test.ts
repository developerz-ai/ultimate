// Presence's rule, with no renderer: an exiting node is HELD until its exit finishes, a re-enter
// mid-exit reverses the running animation from where it is (no jump, no second animation), and
// dispose leaves nothing running.

import { describe, expect, test } from 'bun:test';
import type { MotionHandle } from './animate';
import { type PresenceState, presenceView } from './presence-view';

function driver() {
  const log: string[] = [];
  const runs: { kind: string; finish: () => void }[] = [];
  return {
    log,
    runs,
    /** Finish the latest run and let its promise settle. */
    async finish(): Promise<void> {
      runs.at(-1)?.finish();
      await Promise.resolve();
      await Promise.resolve();
    },
    play(kind: 'enter' | 'exit'): MotionHandle {
      log.push(`play ${kind}`);
      let finish = (): void => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      runs.push({ kind, finish });
      return {
        finished,
        cancel: () => log.push(`cancel ${kind}`),
        reverse: () => log.push(`reverse ${kind}`),
      };
    },
  };
}

function harness<T>(
  initial: T | false,
  options: { exitBeforeEnter?: boolean; appear?: boolean } = {},
) {
  const d = driver();
  const states: PresenceState<T>[] = [];
  let exits = 0;
  const view = presenceView<T>(initial, d, (state) => states.push(state), {
    ...options,
    onExit: () => {
      exits += 1;
    },
  });
  return { d, view, states, exits: () => exits };
}

describe('presenceView', () => {
  test('a first render that is present plays nothing: server markup is already there', () => {
    const { d, view } = harness('a');
    view.mounted();
    expect(view.state()).toEqual({ phase: 'present', shown: { value: 'a' } });
    expect(d.log).toEqual([]);
  });

  test('appear: the first render enters once mounted', async () => {
    const { d, view } = harness('a', { appear: true });
    expect(view.state().phase).toBe('entering');
    view.mounted();
    expect(d.log).toEqual(['play enter']);
    await d.finish();
    expect(view.state().phase).toBe('present');
  });

  test('exit HOLDS the node until the animation finishes, then removes it and says so', async () => {
    const { d, view, exits } = harness('a');
    view.set(false);
    expect(view.state()).toEqual({ phase: 'exiting', shown: { value: 'a' } });
    expect(d.log).toEqual(['play exit']);
    await d.finish();
    expect(view.state()).toEqual({ phase: 'absent', shown: null });
    expect(exits()).toBe(1);
  });

  test('re-entering mid-exit reverses the exit from where it is — no second animation', async () => {
    const { d, view, exits } = harness('a');
    view.set(false);
    view.set('a');
    expect(d.log).toEqual(['play exit', 'reverse exit']);
    expect(view.state().phase).toBe('entering');
    await d.finish();
    expect(view.state()).toEqual({ phase: 'present', shown: { value: 'a' } });
    expect(exits()).toBe(0);
  });

  test('leaving mid-enter reverses the enter the same way', async () => {
    const { d, view } = harness<string>(false);
    view.set('a');
    view.set(false);
    expect(d.log).toEqual(['play enter', 'reverse enter']);
    await d.finish();
    expect(view.state().phase).toBe('absent');
  });

  test('a stale run settling after a newer one started changes nothing', async () => {
    const { d, view } = harness<string>(false);
    view.set('a');
    const first = d.runs[0];
    await d.finish();
    view.set(false);
    first?.finish();
    await Promise.resolve();
    expect(view.state().phase).toBe('exiting');
  });

  test('exitBeforeEnter: a new value waits for the old one to leave, then enters', async () => {
    const { d, view } = harness('a', { exitBeforeEnter: true });
    view.set('b');
    expect(view.state()).toEqual({ phase: 'exiting', shown: { value: 'a' } });
    await d.finish();
    expect(view.state()).toEqual({ phase: 'entering', shown: { value: 'b' } });
    expect(d.log).toEqual(['play exit', 'play enter']);
  });

  test('without exitBeforeEnter a new value swaps in place', () => {
    const { d, view } = harness('a');
    view.set('b');
    expect(view.state()).toEqual({ phase: 'present', shown: { value: 'b' } });
    expect(d.log).toEqual([]);
  });

  test('dispose cancels the running animation and ignores every later call', async () => {
    const { d, view, states } = harness('a');
    view.set(false);
    view.dispose();
    const seen = states.length;
    await d.finish();
    view.set('a');
    expect(d.log).toEqual(['play exit', 'cancel exit']);
    expect(states.length).toBe(seen);
  });
});

describe('presenceView — swaps while leaving', () => {
  test('a new value arriving mid-exit (no exitBeforeEnter) turns the exit back and shows it', () => {
    const { d, view } = harness('a');
    view.set(false);
    view.set('b');
    expect(d.log).toEqual(['play exit', 'reverse exit']);
    expect(view.state()).toEqual({ phase: 'entering', shown: { value: 'b' } });
  });
});
