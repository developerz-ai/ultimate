import { describe, expect, test } from 'bun:test';
import type { BeforeInstallPromptEventLike, InstallHost } from './install';
import { createInstallController, iosInstallGuidance, MIN_ENGAGEMENT_MS } from './install';

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

function fakeHost(
  now: () => number,
  userAgent = 'Chrome/130',
): InstallHost & {
  fire(type: string, event: unknown): void;
} {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  return {
    userAgent,
    standalone: false,
    now,
    addEventListener(type, handler) {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener(type, handler) {
      handlers.get(type)?.delete(handler);
    },
    fire(type, event) {
      for (const handler of handlers.get(type) ?? []) handler(event);
    },
  };
}

function promptEvent(outcome: 'accepted' | 'dismissed'): BeforeInstallPromptEventLike & {
  prevented: boolean;
} {
  return {
    prevented: false,
    preventDefault(): void {
      this.prevented = true;
    },
    prompt: async (): Promise<void> => undefined,
    userChoice: Promise.resolve({ outcome }),
  };
}

describe('createInstallController', () => {
  test('captures beforeinstallprompt and suppresses the browser bar', () => {
    const host = fakeHost(() => 0);
    const controller = createInstallController({ host });
    expect(controller.canInstall()).toBe(false);

    const event = promptEvent('accepted');
    host.fire('beforeinstallprompt', event);

    expect(event.prevented).toBe(true);
    expect(controller.canInstall()).toBe(true);
  });

  test('never prompts on first paint', async () => {
    let now = 0;
    const host = fakeHost(() => now);
    const controller = createInstallController({ host });
    host.fire('beforeinstallprompt', promptEvent('accepted'));

    expect(await controller.prompt()).toBe('too-early');
    now = MIN_ENGAGEMENT_MS + 1;
    expect(await controller.prompt()).toBe('accepted');
    expect(controller.canInstall()).toBe(false);
  });

  test('reports unavailable when the platform never offered a prompt', async () => {
    const controller = createInstallController({ host: fakeHost(() => 1_000_000) });
    expect(await controller.prompt()).toBe('unavailable');
  });
});

describe('iosInstallGuidance', () => {
  test('iOS gets guided steps as i18n keys, other platforms get none', () => {
    expect(iosInstallGuidance(IOS_UA, false)?.stepKeys.length).toBe(2);
    expect(iosInstallGuidance(IOS_UA, true)).toBe(null);
    expect(iosInstallGuidance('Chrome/130', false)).toBe(null);
  });
});

describe('after the app is installed', () => {
  test('appinstalled clears the deferred prompt — no "Install" on an installed app', async () => {
    const host = fakeHost(() => MIN_ENGAGEMENT_MS + 1);
    const controller = createInstallController({ host });
    host.fire('beforeinstallprompt', promptEvent('accepted'));
    expect(controller.canInstall()).toBe(true);
    expect(controller.installed()).toBe(false);

    host.fire('appinstalled', {});

    expect(controller.installed()).toBe(true);
    expect(controller.canInstall()).toBe(false);
    // The captured event is dropped too: prompting a second time throws in real browsers.
    expect(await controller.prompt()).toBe('unavailable');
  });

  test('an event with no prompt() is not a beforeinstallprompt and is ignored', () => {
    const host = fakeHost(() => 0);
    const controller = createInstallController({ host });

    host.fire('beforeinstallprompt', { preventDefault: (): void => undefined });

    expect(controller.canInstall()).toBe(false);
  });
});

describe('the controller signals', () => {
  test('subscribers see each change once, and unsubscribing stops them', () => {
    const host = fakeHost(() => 0);
    const controller = createInstallController({ host });
    const seen: boolean[] = [];
    const off = controller.canInstall.subscribe((value) => seen.push(value));

    host.fire('beforeinstallprompt', promptEvent('accepted'));
    // A second capture is the same value: a signal that re-notifies re-renders the whole shell.
    host.fire('beforeinstallprompt', promptEvent('accepted'));
    expect(seen).toEqual([true]);

    off();
    host.fire('appinstalled', {});
    expect(seen).toEqual([true]);
    expect(controller.canInstall()).toBe(false);
  });
});

describe('dispose', () => {
  test('detaches both listeners, so a disposed controller stops reacting', () => {
    const host = fakeHost(() => 0);
    const controller = createInstallController({ host });

    controller.dispose();
    host.fire('beforeinstallprompt', promptEvent('accepted'));
    host.fire('appinstalled', {});

    expect(controller.canInstall()).toBe(false);
    expect(controller.installed()).toBe(false);
  });
});

/**
 * `now() - startedAt < NaN` is false at every instant, so an engagement threshold that arrived
 * non-finite does not shorten the wait — it deletes it, and the install prompt fires on first
 * paint, which is the one thing this controller exists to prevent. `0` stays legal: "ask as soon
 * as the browser offers" is a decision an app may take, and it is a comparison that still works.
 */
describe('a non-finite engagement threshold is refused', () => {
  test('a NaN minEngagementMs is refused instead of prompting on first paint', () => {
    expect(() =>
      createInstallController({ host: fakeHost(() => 0), minEngagementMs: Number.NaN }),
    ).toThrow(/minEngagementMs/);
  });

  test('zero still means "as soon as the browser offers"', async () => {
    const host = fakeHost(() => 0);
    const controller = createInstallController({ host, minEngagementMs: 0 });
    host.fire('beforeinstallprompt', promptEvent('accepted'));
    expect(await controller.prompt()).toBe('accepted');
  });
});
