// The shell's one job: the state a submit produces reaches the app through the RUNTIME's signal.
// A binding that answered from its own closed-over snapshot would render the first answer forever,
// and every assertion about the pure core would still pass.

import { afterEach, describe, expect, test } from 'bun:test';
import { INERT_SOLID_RUNTIME } from '../theme/inert-runtime';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import type { Accessor, Setter, SolidRuntime } from '../theme/solid-adapter';
import type { FormIssue } from './form-issue';
import { useForm } from './use-form';

const raw = (found: FormIssue): string => found.message;

interface Counted {
  runtime: SolidRuntime;
  reads: number;
  writes: number;
}

/** A runtime that counts, so "went through the signal" is a number rather than a belief. */
function countingRuntime(): Counted {
  const counted: Counted = { runtime: INERT_SOLID_RUNTIME, reads: 0, writes: 0 };
  counted.runtime = {
    ...INERT_SOLID_RUNTIME,
    createSignal: <T>(value: T): [Accessor<T>, Setter<T>] => {
      let current = value;
      return [
        () => {
          counted.reads += 1;
          return current;
        },
        (next: T) => {
          counted.writes += 1;
          current = next;
        },
      ];
    },
  };
  return counted;
}

afterEach(() => {
  clearSolidRuntime();
});

describe('useForm', () => {
  test('mirrors every transition into the runtime’s signal and answers off it', async () => {
    const counted = countingRuntime();
    setSolidRuntime(counted.runtime);

    const form = useForm<{ title: string }, { id: string }>({
      fields: ['title'],
      messageFor: raw,
      submit: () => Promise.reject({ code: 'X_INPUT_INVALID', cause: 'title: too short' }),
    });

    await form.submit({ title: '' });
    // submitting + failed.
    expect(counted.writes).toBe(2);

    const before = counted.reads;
    expect(form.errorFor('title')).toBe('too short');
    expect(counted.reads).toBeGreaterThan(before);
    expect(form.state().status).toBe('failed');
  });

  test('renders idle on a server, where there is no runtime to register', () => {
    const form = useForm<{ title: string }, { id: string }>({
      fields: ['title'],
      messageFor: raw,
      submit: () => Promise.resolve({ id: 'x' }),
    });
    expect(form.state().status).toBe('idle');
    expect(form.errorFor('title')).toBeUndefined();
  });

  test('an onState the caller passed still fires — the shell adds to it, never replaces it', async () => {
    setSolidRuntime(countingRuntime().runtime);
    const seen: string[] = [];
    const form = useForm<{ title: string }, { id: string }>({
      fields: ['title'],
      messageFor: raw,
      onState: (state) => seen.push(state.status),
      submit: () => Promise.resolve({ id: 'x' }),
    });
    await form.submit({ title: 'a' });
    expect(seen).toEqual(['submitting', 'succeeded']);
  });
});
