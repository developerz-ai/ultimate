// TEST-ONLY. A DOM small enough to read and real enough to run this package's keyboard code
// against: focus that a disabled control silently refuses, `document.activeElement`, `contains`,
// and `querySelectorAll` for the selector grammar these helpers actually pass. Not exported from
// `index.ts` — the alternative is a DOM dependency, and the bugs it catches are the ones that only
// exist because nothing ever called `createRovingTabindex` with elements attached.

/** The subset of a selector these helpers use: comma groups of tag + `[attr]` + `:not(...)`. */
const PART = /\[[^\]]*\]|:not\([^)]*\)/g;

function attrMatches(element: FakeElement, test: string): boolean {
  const inner = test.slice(1, -1);
  const eq = inner.indexOf('=');
  if (eq === -1) return element.getAttribute(inner) !== null;
  const name = inner.slice(0, eq);
  const value = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
  return element.getAttribute(name) === value;
}

function compoundMatches(element: FakeElement, compound: string): boolean {
  const tag = compound.split(/[[:]/, 1)[0] ?? '';
  if (tag !== '' && tag !== element.tagName.toLowerCase()) return false;
  for (const part of compound.slice(tag.length).match(PART) ?? []) {
    const ok = part.startsWith(':not(')
      ? !attrMatches(element, part.slice(5, -1))
      : attrMatches(element, part);
    if (!ok) return false;
  }
  return true;
}

/** Listener book shared by the element and the document: registration only, and NO bubbling — a
 * listener on a node never sees an event dispatched somewhere else, which is the whole point of
 * the question `createFocusTrap` gets wrong. */
class Listeners {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  dispatch(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
}

const NATIVELY_FOCUSABLE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
const LINK_TAGS = new Set(['A', 'AREA']);

/** An element that behaves like the real thing in the two ways this package's bugs depend on. */
export class FakeElement extends Listeners {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly attrs: Record<string, string>;
  /** Test assertion surface: how many times focus actually landed here. */
  focusCount = 0;
  owner: FakeDocument | null = null;

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    super();
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
  }

  get tabIndex(): number {
    return Number.parseInt(this.attrs['tabindex'] ?? '-1', 10);
  }

  set tabIndex(value: number) {
    this.attrs['tabindex'] = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  append(...children: readonly FakeElement[]): FakeElement {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
    return this;
  }

  /** The bug's mechanism, faithfully: focusing a disabled control does NOTHING and reports nothing.
   * A tag that is not natively focusable and carries no `tabindex` refuses in exactly the same
   * silence — `<div>.focus()` is the no-op behind the focus trap's empty-panel fallback. */
  focus(): void {
    if (this.getAttribute('disabled') !== null) return;
    // `tabindex="-1"` IS focusable programmatically; it is only out of the TAB order.
    const declared = this.getAttribute('tabindex') !== null;
    if (!declared && !this.nativelyFocusable()) return;
    this.focusCount += 1;
    const doc = this.document();
    if (doc !== null) doc.activeElement = this;
  }

  contains(node: unknown): boolean {
    for (let at = node as FakeElement | null; at !== null; at = at.parent) {
      if (at === this) return true;
    }
    return false;
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const groups = selector.split(',').map((one) => one.trim());
    return this.descendants().filter((el) => groups.some((one) => compoundMatches(el, one)));
  }

  // `focusableWithin` filters on visibility; nothing in a fake tree is laid out, so everything is
  // visible — a hidden-element rule would be this harness inventing a fact, not testing one.
  readonly offsetParent: unknown = null;

  getClientRects(): readonly unknown[] {
    return [{}];
  }

  /** Focusable with no `tabindex` at all. `A`/`AREA` only with an `href` — the same condition
   * `FOCUSABLE_SELECTOR` spells `a[href]`. */
  private nativelyFocusable(): boolean {
    if (NATIVELY_FOCUSABLE.has(this.tagName)) return true;
    return LINK_TAGS.has(this.tagName) && this.getAttribute('href') !== null;
  }

  private document(): FakeDocument | null {
    for (let at: FakeElement | null = this; at !== null; at = at.parent) {
      if (at.owner !== null) return at.owner;
    }
    return null;
  }
}

export interface FakeKeyboardEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
}

export function keydown(key: string, shiftKey = false): FakeKeyboardEvent {
  return {
    key,
    shiftKey,
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
  };
}

export class FakeDocument extends Listeners {
  activeElement: FakeElement | null = null;
}

export interface InstalledDom {
  readonly document: FakeDocument;
  readonly restore: () => void;
}

/**
 * Publish `document` and `HTMLElement` globally for the duration of one test. Both are needed:
 * `createRovingTabindex` reads `document.activeElement` and narrows it with `instanceof
 * HTMLElement`, so a fake that is not the global class is silently treated as "focus is nowhere".
 * ALWAYS restored — `solid()` decides a render is a server render by `document` being absent, and
 * a leaked one turns every later component test in the process into `X_UI_RUNTIME_MISSING`.
 */
export function installFakeDom(root: FakeElement): InstalledDom {
  const document = new FakeDocument();
  root.owner = document;
  const hadDocument = 'document' in globalThis;
  const hadElement = 'HTMLElement' in globalThis;
  const previousDocument: unknown = Reflect.get(globalThis, 'document');
  const previousElement: unknown = Reflect.get(globalThis, 'HTMLElement');
  Object.assign(globalThis, { document, HTMLElement: FakeElement });
  return {
    document,
    restore(): void {
      if (hadDocument) Object.assign(globalThis, { document: previousDocument });
      else Reflect.deleteProperty(globalThis, 'document');
      if (hadElement) Object.assign(globalThis, { HTMLElement: previousElement });
      else Reflect.deleteProperty(globalThis, 'HTMLElement');
    },
  };
}
