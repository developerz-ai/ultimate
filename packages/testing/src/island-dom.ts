// A DOM small enough to read, implementing exactly what compiled Solid touches and nothing else.
// `bun test` ships no DOM and no DOM library may be added, so an island — the only client-side
// code Ultimate ships — was untestable without one. `generate: 'dom'` builds every element from
// `_$template("<button …>")`, so a stub without a parsed `<template>` cannot run one line of it.

/** `[data-role="preview"]` — the one selector shape a mounted island is queried by. */
const ATTRIBUTE_SELECTOR = /^\[([\w-]+)="([^"]*)"\]$/;

export class FakeNode {
  readonly nodeType: number = 1;
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    const at = ref === null ? -1 : this.children.indexOf(ref);
    child.parentNode = this;
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
    return child;
  }
  replaceChild(next: FakeNode, prev: FakeNode): FakeNode {
    const at = this.children.indexOf(prev);
    if (at >= 0) this.children[at] = next;
    next.parentNode = this;
    return prev;
  }
  removeChild(child: FakeNode): FakeNode {
    this.children = this.children.filter((each) => each !== child);
    return child;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  cloneNode(deep?: boolean): FakeNode {
    const copy = new FakeNode();
    if (deep === true) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  get childNodes(): readonly FakeNode[] {
    return this.children;
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }
  set textContent(text: string) {
    this.children = text === '' ? [] : [new FakeText(text)];
  }
}

/** `data`, not a private field: Solid updates a text node in place through `node.data = value`,
 *  and a stub without it reports a mount that renders once and never re-renders. */
export class FakeText extends FakeNode {
  override readonly nodeType = 3;
  constructor(public data: string) {
    super();
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(text: string) {
    this.data = text;
  }
  override cloneNode(): FakeText {
    return new FakeText(this.data);
  }
}

/**
 * The three writes compiled Solid makes to `style`, over ONE declaration map: `setProperty` and
 * `removeProperty` (`setStyleProperty`, `solid-js/web`'s `web.js:302`, which is what the compiler
 * emits per dynamic entry of a `style={{ … }}` prop) and `cssText` (its `style()` runtime, for a
 * whole-object or string prop). It RECORDS: `<Form>`, `<Stack>`, `<Grid>` and `<Container>` each
 * set a custom property, so `style = {}` killed every one of them inside `mount`, and a no-op that
 * only stopped the crash would leave "the component set `--form-gap`" untestable instead — the
 * same shape of hole one layer down.
 */
export class FakeStyle {
  /** Declaration order, as `CSSStyleDeclaration` enumerates. */
  readonly properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, String(value));
  }

  /** The old value, as the DOM's does — Solid ignores it, a test asserting a removal need not. */
  removeProperty(name: string): string {
    const previous = this.properties.get(name) ?? '';
    this.properties.delete(name);
    return previous;
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? '';
  }

  get cssText(): string {
    return [...this.properties].map(([name, value]) => `${name}: ${value};`).join(' ');
  }

  /** A declaration with no `:` is dropped rather than stored, which is also how Solid's own reset
   *  lands: `style()` assigns `undefined` here to clear, and the DOM parses that to nothing. */
  set cssText(text: string) {
    this.properties.clear();
    for (const declaration of String(text).split(';')) {
      const at = declaration.indexOf(':');
      if (at > 0) {
        this.properties.set(declaration.slice(0, at).trim(), declaration.slice(at + 1).trim());
      }
    }
  }
}

/**
 * Backed by the element's `class` ATTRIBUTE rather than a list of its own: `classList.toggle` is
 * emitted inline by the compiler for `classList={{ … }}` while `class` goes through `className`,
 * and two representations would let one element answer a test two ways. `toggle` is the call Solid
 * makes and `add` was the one this stood in for — the double implemented the method nothing calls.
 */
export class FakeClassList {
  constructor(private readonly element: FakeElement) {}

  private get names(): string[] {
    return this.element.className.split(/\s+/).filter((name) => name.length > 0);
  }

  private write(names: readonly string[]): void {
    this.element.className = names.join(' ');
  }

  add(...names: readonly string[]): void {
    this.write([...this.names, ...names.filter((name) => !this.contains(name))]);
  }

  remove(...names: readonly string[]): void {
    this.write(this.names.filter((name) => !names.includes(name)));
  }

  contains(name: string): boolean {
    return this.names.includes(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const next = force ?? !this.contains(name);
    if (next) this.add(name);
    else this.remove(name);
    return next;
  }
}

export class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (event: unknown) => void>();
  /** Plain object, so `delete el.dataset.theme` behaves as the DOM's `DOMStringMap` does. */
  readonly dataset: Record<string, string> = {};
  readonly classList: FakeClassList = new FakeClassList(this);
  readonly style = new FakeStyle();
  /** Properties, not attributes: Solid assigns both of these straight onto the node. */
  value = '';
  checked = false;
  constructor(readonly tagName: string) {
    super();
  }
  get nodeName(): string {
    return this.tagName.toUpperCase();
  }
  /** `_$className` assigns the PROPERTY, never the attribute — class assertions read this. */
  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(value: string) {
    this.attributes.set('class', String(value));
  }
  /**
   * `style` is the declaration map wearing an attribute's name, in all four calls. Both spellings
   * are Solid's own: the compiler bakes a STATIC style entry into the template's `style=` attribute
   * — which `parseHtml` sets here — and clears a whole-object prop through `removeAttribute`
   * (`setAttribute(node, 'style')` with no value, `web.js:237`), while every dynamic entry goes to
   * `style.setProperty`. Two stores would let one element answer `getAttribute('style')` and
   * `style.getPropertyValue` differently.
   */
  setAttribute(name: string, value: string): void {
    if (name === 'style') this.style.cssText = String(value);
    else this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    if (name === 'style') return this.style.properties.size === 0 ? null : this.style.cssText;
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return name === 'style' ? this.style.properties.size > 0 : this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    if (name === 'style') this.style.properties.clear();
    else this.attributes.delete(name);
  }
  addEventListener(name: string, fn: (event: unknown) => void): void {
    this.listeners.set(name, fn);
  }
  removeEventListener(name: string): void {
    this.listeners.delete(name);
  }
  override cloneNode(deep?: boolean): FakeElement {
    const copy = new FakeElement(this.tagName);
    for (const [name, value] of this.attributes) copy.attributes.set(name, value);
    // The declarations too, or a template's static `style=` survives the parse and dies at the
    // `importNode` every compiled island mounts through.
    for (const [name, value] of this.style.properties) copy.style.properties.set(name, value);
    if (deep === true) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  /**
   * A tag name or `[attr="value"]`, anywhere in the subtree — the two shapes an island test asks
   * for. Anything richer would be a CSS engine, which is a DOM library by another name.
   *
   * DESCENDANTS only, never `this`: the DOM's own `querySelector` does not match the element it is
   * called on, and a host `<div>` answering `find('div')` reports the container the test built
   * instead of the markup the island rendered into it.
   */
  querySelectorAll(selector: string): readonly FakeElement[] {
    const attribute = ATTRIBUTE_SELECTOR.exec(selector);
    const found: FakeElement[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        if (child instanceof FakeElement && matches(child, selector, attribute)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

const matches = (
  node: FakeElement,
  selector: string,
  attribute: RegExpExecArray | null,
): boolean =>
  attribute === null
    ? node.tagName === selector
    : node.getAttribute(attribute[1] as string) === attribute[2];

export class FakeTemplate extends FakeElement {
  content: FakeNode = new FakeNode();
  constructor() {
    super('template');
  }
  set innerHTML(html: string) {
    this.content = parseHtml(html);
  }
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
const TOKEN =
  /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([^\s=/>]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** Only what `babel-preset-solid` emits into a template: tags, static attributes and text. */
export function parseHtml(html: string): FakeNode {
  const root = new FakeNode();
  const open: FakeNode[] = [root];
  for (const match of html.matchAll(TOKEN)) {
    const parent = open[open.length - 1] as FakeNode;
    if (match[5] !== undefined) {
      parent.appendChild(new FakeText(match[5]));
      continue;
    }
    if (match[1] === '/') {
      if (open.length > 1) open.pop();
      continue;
    }
    const element = new FakeElement(match[2] as string);
    for (const attr of (match[3] ?? '').matchAll(ATTRIBUTE)) {
      if (attr[1] !== undefined) element.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    parent.appendChild(element);
    if (match[4] !== '/' && !VOID_TAGS.has(element.tagName)) open.push(element);
  }
  return root;
}

export interface IslandDocument {
  readonly documentElement: FakeElement;
  readonly globals: Readonly<Record<string, unknown>>;
}

/**
 * A fresh `<html>` and the globals a compiled island reads, built per mount rather than once per
 * module: `document.documentElement.dataset.theme` is state one island writes and the next would
 * otherwise inherit.
 */
export function createIslandDocument(): IslandDocument {
  const documentElement = new FakeElement('html');
  const document = {
    documentElement,
    createElement: (tag: string): FakeElement =>
      tag === 'template' ? new FakeTemplate() : new FakeElement(tag),
    createElementNS: (_ns: string, tag: string): FakeElement => new FakeElement(tag),
    createTextNode: (text: string): FakeText => new FakeText(text),
    createComment: (): FakeText => new FakeText(''),
    importNode: (node: FakeNode, deep?: boolean): FakeNode => node.cloneNode(deep),
    // The document's listeners are the documentElement's, because this DOM has no bubbling at all
    // and a no-op here made a whole shape of component undrivable: `@ultimat3/ui`'s Menu, Popover
    // and focus trap each close on an Escape registered on `document`, never on their own node, so
    // a test could mount one and never shut it. `fire(mounted.documentElement, 'keydown', …)`
    // reaches them through the surface `MountedIsland` already exposes.
    addEventListener: (name: string, fn: (event: unknown) => void): void =>
      documentElement.addEventListener(name, fn),
    removeEventListener: (name: string): void => documentElement.removeEventListener(name),
  };
  return {
    documentElement,
    globals: {
      // Solid's event delegation reads `window` before it reads anything else.
      window: globalThis,
      Element: FakeElement,
      SVGElement: FakeElement,
      Node: FakeNode,
      Text: FakeText,
      document,
    },
  };
}

/** The delegated handler Solid parks on the node as `$$click`, or a listener it attached with
 *  `addEventListener` — a compiled island uses one or the other and a driver must accept both. */
export function handlerFor(
  element: FakeElement,
  type: string,
): ((event: unknown) => void) | undefined {
  const delegated = (element as unknown as Record<string, unknown>)[`$$${type}`];
  if (typeof delegated === 'function') return delegated as (event: unknown) => void;
  return element.listeners.get(type);
}
