// `panelPayload`'s catch owes its caller a `/_x` response, so nothing in it may throw. Every read
// it makes is on a value the framework did not build: a panel's source is an app's driver, and a
// rejection can be any value at all.

import { describe, expect, test } from 'bun:test';
import type { DevSources } from './facts';
import type { DevPanel } from './panel';
import { panelPayload } from './panel';

const panelRejecting = (value: unknown): DevPanel => ({
  key: 'probe',
  titleKey: 'dev.panel.probe.title',
  questionKey: 'dev.panel.probe.question',
  data: () => Promise.reject(value),
});

const render = (value: unknown): Promise<unknown> =>
  panelPayload(panelRejecting(value), {} as DevSources, new URLSearchParams());

describe('panelPayload survives every shape a panel can reject with', () => {
  test('a null-prototype rejection renders instead of throwing inside the catch', async () => {
    // `String(Object.create(null))` THROWS — no `toString`, no `Symbol.toPrimitive` — and the
    // local helper this replaced called it. The `/_x` request became an unhandled rejection.
    const payload = await render(Object.create(null));
    expect(payload).toMatchObject({
      panel: 'probe',
      ok: false,
      error: { code: 'X_NOT_IMPLEMENTED', fix: 'x dev --help' },
    });
    expect(typeof (payload as { error: { cause: unknown } }).error.cause).toBe('string');
  });

  test('a value whose code getter throws still renders a payload', async () => {
    const hostile = {
      get code(): string {
        throw new TypeError('the code getter refused');
      },
      get cause(): string {
        throw new TypeError('the cause getter refused');
      },
    };
    const payload = await render(hostile);
    expect(payload).toMatchObject({ ok: false, error: { code: 'X_NOT_IMPLEMENTED' } });
  });

  test('an UltimateError-shaped rejection keeps its own code, cause and fix', async () => {
    const payload = await render({
      code: 'X_DEV_SOURCE_UNAVAILABLE',
      cause: 'no sync node is wired',
      fix: 'x dev --json',
    });
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: 'X_DEV_SOURCE_UNAVAILABLE',
        cause: 'no sync node is wired',
        fix: 'x dev --json',
      },
    });
  });

  test('a plain Error still contributes its message to the cause', async () => {
    const payload = await render(new Error('the driver went away'));
    expect((payload as { error: { cause: string } }).error.cause).toContain('the driver went away');
  });
});
