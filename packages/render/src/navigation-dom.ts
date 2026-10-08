/**
 * The client router's small DOM helpers: reading a link or a form into the facts the rules take,
 * the view transition, where focus lands, the live region, and handing a non-page answer to the
 * browser. Split from `navigation.ts` so that file is the controller and nothing else.
 */

import type { FormFacts, LinkFacts } from './navigation-rules';
import {
  linkVerdict,
  mayPrefetch,
  NAVIGATION_NO_PREFETCH_ATTRIBUTE,
  NAVIGATION_RELOAD_ATTRIBUTE,
} from './navigation-rules';

/** A link as the rules read it; `event` absent for a hover, which is no click at all. */
export function linkFacts(
  win: Window,
  anchor: HTMLAnchorElement | HTMLAreaElement,
  event?: MouseEvent,
): LinkFacts {
  return {
    href: anchor.href,
    current: win.location.href,
    button: event?.button ?? 0,
    modified:
      event !== undefined && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey),
    defaultPrevented: event?.defaultPrevented ?? false,
    target: anchor.target,
    download: anchor.hasAttribute('download'),
    rel: anchor.getAttribute('rel') ?? '',
    reload: anchor.hasAttribute(NAVIGATION_RELOAD_ATTRIBUTE),
  };
}

export function anchorOf(target: EventTarget | null): HTMLAnchorElement | HTMLAreaElement | null {
  const el = (target as Element | null)?.closest?.('a[href],area[href]') ?? null;
  // An SVG `<a>`'s `href` is an animated string, not a URL: the browser keeps those.
  return el !== null && typeof (el as HTMLAnchorElement).href === 'string'
    ? (el as HTMLAnchorElement)
    : null;
}

/** The URL a hover or focus on `target` may prefetch, or `undefined` (`linkVerdict`, `mayPrefetch`). */
export function intentUrl(win: Window, target: EventTarget | null): string | undefined {
  const anchor = anchorOf(target);
  if (anchor === null) return undefined;
  const verdict = linkVerdict(linkFacts(win, anchor));
  if (verdict.kind !== 'soft') return undefined;
  const connection = (
    win.navigator as { connection?: { saveData?: boolean; effectiveType?: string } }
  ).connection;
  const may = mayPrefetch({
    url: verdict.url,
    noPrefetch: anchor.hasAttribute(NAVIGATION_NO_PREFETCH_ATTRIBUTE),
    saveData: connection?.saveData,
    effectiveType: connection?.effectiveType,
  });
  return may ? verdict.url : undefined;
}

/** A field as a GET query carries it: a file by its name, as the browser does. */
export const fieldText = (value: unknown): string =>
  value instanceof File ? value.name : String(value);

/** Every lone CR, lone LF and CRLF in `text`, as CRLF. */
const crlf = (text: string): string => text.replace(/\r\n|\r|\n/g, '\r\n');

/**
 * The fields as a GET query or a urlencoded body carries them — names and values with their line
 * breaks normalised to CRLF, as the browser's own submit does (HTML's "convert to a list of
 * name-value pairs"). A `<textarea>`'s value holds bare LFs; sent as they were, the router's
 * submit and a native one delivered two different bodies for one form. A multipart body needs
 * none of this: `fetch` encodes a `FormData` with the same normalisation.
 */
export const formPairs = (fields: FormData): readonly (readonly [string, string])[] =>
  [...fields].map(([name, value]: [string, unknown]) => [crlf(name), crlf(fieldText(value))]);

/**
 * A form's action, resolved against the document — or the raw text when it does not resolve, which
 * `formVerdict` leaves to the browser (`'unparsable'`) rather than throwing from a submit handler.
 */
export function formAction(raw: string, fallback: string, base: string): string {
  const action = raw || fallback;
  return URL.canParse(action, base) ? new URL(action, base).href : action;
}

/** The submitted fields, the submitter's own name/value included, as the browser would send. */
export function formFields(form: HTMLFormElement, submitter: HTMLElement | null): FormData {
  try {
    return new FormData(form, submitter);
  } catch {
    return new FormData(form);
  }
}

/** A submit as the rules read it — the submitter's `form*` attributes over the form's — and its fields. */
export function submitFacts(
  win: Window,
  form: HTMLFormElement,
  submitter: HTMLElement | null,
  defaultPrevented: boolean,
): { readonly facts: FormFacts; readonly fields: FormData } {
  const fields = formFields(form, submitter);
  const say = (attr: string, fallback: string): string =>
    submitter?.getAttribute(`form${attr}`) ?? form.getAttribute(attr) ?? fallback;
  const facts: FormFacts = {
    action: formAction(say('action', ''), win.location.href, win.document.baseURI),
    current: win.location.href,
    method: say('method', 'get').toLowerCase(),
    enctype: say('enctype', 'application/x-www-form-urlencoded').toLowerCase(),
    target: say('target', ''),
    defaultPrevented,
    reload:
      form.hasAttribute(NAVIGATION_RELOAD_ATTRIBUTE) ||
      submitter?.hasAttribute(NAVIGATION_RELOAD_ATTRIBUTE) === true,
    // `unknown`: a browser yields a `File` for a file input, whatever a server-side type says.
    hasFile: [...fields.values()].some(
      (value: unknown) => value instanceof File && value.name !== '',
    ),
    fields: formPairs(fields),
  };
  return { facts, fields };
}

const hush = (): void => undefined;

/**
 * The swap inside a view transition when the browser has one and motion is welcome. A transition
 * the browser skips rejects `ready` and `finished`; both are answered here, so a navigation never
 * leaves an unhandled rejection behind. A throw inside `apply` rejects `updateCallbackDone`, which
 * the caller awaits and turns into a full load.
 */
export async function transition(
  win: Window,
  apply: () => void,
  track?: (running: RunningTransition, finished: boolean) => void,
): Promise<void> {
  const doc = win.document as Document & {
    startViewTransition?: (update: () => void) => RunningTransition;
  };
  const still = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  if (doc.startViewTransition === undefined || still) {
    apply();
    return;
  }
  const running = doc.startViewTransition(apply);
  track?.(running, false);
  running.ready.catch(hush);
  // The transition itself, never "whichever is running": an older one finishing after a newer one
  // started must not clear the newer one (the caller compares by identity).
  const done = (): void => track?.(running, true);
  running.finished.then(done, done);
  await running.updateCallbackDone;
}

/** The part of a `ViewTransition` the router uses. */
export interface RunningTransition {
  readonly updateCallbackDone: Promise<void>;
  readonly ready: Promise<void>;
  readonly finished: Promise<void>;
  skipTransition?(): void;
}

/** Where a keyboard or screen-reader user lands: the page's `<main>`, else its first heading. */
export function focusMain(doc: Document): void {
  const target = doc.querySelector<HTMLElement>('main') ?? doc.querySelector<HTMLElement>('h1');
  if (target === null) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/** A polite live region carried from body to body; styled through the CSSOM, which CSP allows. */
export function announcer(doc: Document): HTMLElement {
  const region = doc.createElement('div');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  Object.assign(region.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  });
  doc.body.append(region);
  return region;
}

/**
 * The file name a `Content-Disposition` names — `filename*` (RFC 8187) first, then `filename` — or
 * `''` for the browser to choose. Never throws: a malformed escape falls back, and no path
 * separator survives, so a header cannot name a place to write.
 */
export function dispositionName(disposition: string): string {
  const encoded = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(disposition)?.[1];
  let name = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(disposition);
  let out = name?.[1] ?? name?.[2]?.trim() ?? '';
  if (encoded !== undefined) {
    try {
      out = decodeURIComponent(encoded.trim());
    } catch {
      // A malformed escape: the plain `filename` (or none) stands.
    }
  }
  name = null;
  return out.replace(/[\\/]/g, '_');
}

/** Whether the server asked for the bytes to be saved rather than shown. */
export const isAttachment = (disposition: string): boolean => /^\s*attachment/i.test(disposition);

/** How long a saved file's blob URL outlives the click that saved it. */
const REVOKE_AFTER_MS = 60_000;

/**
 * An answer that is not a page, handed to the browser from the bytes ALREADY received — the
 * route ran once, and asking again would run it twice (a download recorded as two). Saved under
 * its own name when the server said `attachment`; otherwise shown, as a navigation would.
 */
export function handOver(win: Window, body: Blob, disposition: string): void {
  const url = URL.createObjectURL(body);
  if (isAttachment(disposition)) {
    const link = win.document.createElement('a');
    link.href = url;
    link.download = dispositionName(disposition);
    link.click();
    win.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
    return;
  }
  // The document that holds the URL is leaving; the browser frees it with the document.
  win.location.assign(url);
}
