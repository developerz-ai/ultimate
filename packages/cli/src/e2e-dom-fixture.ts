// A document small enough to hold in a test and real enough to RUN the driver's own in-page
// expressions. Without it every claim about `getByRole` and `getByText` would be an assertion
// about a string, and a string that never executes cannot be wrong about a page.
//
// Its own file, the pattern `dev-roles-fixture.ts` and `policy-fixture.ts` already set here.

/** One element. `attrs` is data, so every read of it goes through `Object.hasOwn` below. */
export interface FakeE2eElement {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly children?: readonly FakeE2eElement[];
  /** What `getComputedStyle` answers. Absent is the browser's own default — visible. */
  readonly style?: { display?: string; visibility?: string; opacity?: string };
}

interface Node {
  tagName: string;
  textContent: string;
  readonly attributes: Record<string, string>;
  readonly descendants: Node[];
  readonly style: { display: string; visibility: string; opacity: string };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  contains(other: Node): boolean;
}

const textOf = (element: FakeE2eElement): string =>
  [element.text ?? '', ...(element.children ?? []).map(textOf)]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

function build(element: FakeE2eElement): Node {
  const attributes: Record<string, string> = { ...element.attrs };
  const children = (element.children ?? []).map(build);
  const descendants = children.flatMap((child) => [child, ...child.descendants]);
  const node: Node = {
    tagName: element.tag.toUpperCase(),
    textContent: textOf(element),
    attributes,
    descendants,
    style: {
      display: element.style?.display ?? 'block',
      visibility: element.style?.visibility ?? 'visible',
      opacity: element.style?.opacity ?? '1',
    },
    getAttribute: (name) => (Object.hasOwn(attributes, name) ? (attributes[name] as string) : null),
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    removeAttribute: (name) => {
      delete attributes[name];
    },
    contains: (other) => descendants.includes(other),
  };
  return node;
}

/** `tag`, `*`, `[attr]`, `[attr="value"]` and any combination — every shape this driver emits. */
const SIMPLE = /^([a-zA-Z0-9*]*)((?:\[[^\]]*\])*)$/;

function matchesSimple(node: Node, selector: string): boolean {
  const parsed = SIMPLE.exec(selector.trim());
  if (parsed === null) return false;
  const tag = parsed[1] ?? '';
  if (tag !== '' && tag !== '*' && tag.toUpperCase() !== node.tagName) return false;
  for (const clause of (parsed[2] ?? '').matchAll(/\[([^\]=]+)(?:=("[^"]*"|[^\]]*))?\]/g)) {
    const name = (clause[1] ?? '').trim();
    const held = node.getAttribute(name);
    if (held === null) return false;
    const raw = clause[2];
    if (raw !== undefined && held !== raw.replace(/^"|"$/g, '')) return false;
  }
  return true;
}

const matches = (node: Node, selector: string): boolean =>
  selector.split(',').some((part) => part.trim() !== '' && matchesSimple(node, part));

/**
 * The globals a driver expression names, bound to one tree. `getComputedStyle` and `document` are
 * handed in as arguments rather than assigned to `globalThis`: a test that installed a fake
 * `document` on the process would leak it into every later file in the run.
 */
export function fakeE2eDocument(root: FakeE2eElement): Readonly<Record<string, unknown>> {
  const rootNode = build(root);
  const all = [rootNode, ...rootNode.descendants];
  return {
    document: {
      querySelectorAll: (selector: string): Node[] => all.filter((node) => matches(node, selector)),
      querySelector: (selector: string): Node | null =>
        all.find((node) => matches(node, selector)) ?? null,
      getElementById: (id: string): Node | null =>
        all.find((node) => node.getAttribute('id') === id) ?? null,
    },
    getComputedStyle: (node: Node) => node.style,
  };
}

/**
 * Run an expression the driver built, in THIS process, against a stubbed global scope.
 *
 * `new Function` and not `eval`: the body evaluates with no access to this module's scope, so a
 * name the expression does not receive as a parameter is genuinely free — which is exactly the
 * `ReferenceError` a captured closure produces in a real browser, and the thing the evaluate
 * wrapper has to be proved against.
 */
export async function runInFakePage(
  expression: string,
  globals: Readonly<Record<string, unknown>> = {},
): Promise<unknown> {
  const names = Object.keys(globals);
  const body = new Function(...names, `return (${expression});`) as (...args: unknown[]) => unknown;
  return await body(...names.map((name) => globals[name]));
}
