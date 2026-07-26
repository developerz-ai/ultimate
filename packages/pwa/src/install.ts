/**
 * Install prompt handling. Two rules: capture `beforeinstallprompt` so the browser's own
 * bar is suppressed and the app owns the moment, and NEVER prompt on first paint — an
 * install prompt before the user knows what the app is converts worse and is dismissed
 * permanently on some platforms.
 */

/** A minimal signal so this file needs no framework runtime. */
export interface ReadSignal<T> {
  (): T;
  subscribe(listener: (value: T) => void): () => void;
}

interface WritableSignal<T> extends ReadSignal<T> {
  set(value: T): void;
}

function createSignal<T>(initial: T): WritableSignal<T> {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  const read = (() => value) as WritableSignal<T>;
  read.set = (next: T): void => {
    if (Object.is(next, value)) return;
    value = next;
    for (const listener of listeners) listener(next);
  };
  read.subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return read;
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable' | 'too-early';

export interface BeforeInstallPromptEventLike {
  preventDefault(): void;
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

/** Structural view of the host, so this runs under `bun test` with no DOM. */
export interface InstallHost {
  addEventListener(type: string, handler: (event: unknown) => void): void;
  removeEventListener(type: string, handler: (event: unknown) => void): void;
  /** `navigator.userAgent`. */
  readonly userAgent: string;
  /** True when already running as an installed app. */
  readonly standalone: boolean;
  readonly now: () => number;
}

export interface InstallOptions {
  readonly host: InstallHost;
  /** How long the user must have been on the page before a prompt is allowed. */
  readonly minEngagementMs?: number;
}

/** Long enough that the prompt follows intent, short enough to still be useful. */
export const MIN_ENGAGEMENT_MS = 30_000;

export interface IosGuidance {
  readonly platform: 'ios';
  /** i18n key — never a literal string. */
  readonly instructionKey: string;
  readonly stepKeys: readonly string[];
}

export interface InstallController {
  readonly canInstall: ReadSignal<boolean>;
  readonly installed: ReadSignal<boolean>;
  /** iOS has no `beforeinstallprompt`; it needs a guided flow instead. */
  readonly iosGuidance: IosGuidance | null;
  prompt(): Promise<InstallOutcome>;
  dispose(): void;
}

export function createInstallController(options: InstallOptions): InstallController {
  const host = options.host;
  const minEngagementMs = options.minEngagementMs ?? MIN_ENGAGEMENT_MS;
  const startedAt = host.now();

  const canInstall = createSignal(false);
  const installed = createSignal(host.standalone);
  let deferred: BeforeInstallPromptEventLike | null = null;

  const onBeforeInstallPrompt = (event: unknown): void => {
    const candidate = event as BeforeInstallPromptEventLike;
    if (typeof candidate?.prompt !== 'function') return;
    // Suppress the browser bar; the app decides when to ask.
    candidate.preventDefault();
    deferred = candidate;
    canInstall.set(true);
  };

  const onInstalled = (): void => {
    deferred = null;
    canInstall.set(false);
    installed.set(true);
  };

  host.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  host.addEventListener('appinstalled', onInstalled);

  return {
    canInstall,
    installed,
    iosGuidance: iosInstallGuidance(host.userAgent, host.standalone),

    async prompt(): Promise<InstallOutcome> {
      if (deferred === null) return 'unavailable';
      if (host.now() - startedAt < minEngagementMs) return 'too-early';
      await deferred.prompt();
      const choice = await deferred.userChoice;
      deferred = null;
      canInstall.set(false);
      return choice.outcome;
    },

    dispose(): void {
      host.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      host.removeEventListener('appinstalled', onInstalled);
    },
  };
}

const IOS_UA = /iphone|ipad|ipod/i;

/** Safari never fires `beforeinstallprompt`; the only install path is Share → Add. */
export function iosInstallGuidance(userAgent: string, standalone: boolean): IosGuidance | null {
  if (standalone || !IOS_UA.test(userAgent)) return null;
  return {
    platform: 'ios',
    instructionKey: 'pwa.install.ios.instruction',
    stepKeys: ['pwa.install.ios.step.share', 'pwa.install.ios.step.addToHome'],
  };
}
