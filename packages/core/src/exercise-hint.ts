// The `input:` an exercise fix pastes: `(drawn) => ({ ...drawn, <each owed field> })`. One renderer
// for every hint that names what a draw could not fill — action's and query's `X_CONTRACT_DRIFT`,
// and the `x exercise` override line — so the three cannot print different shapes.

import { renderFixLiteral } from './error-render';

/** A field the author supplies: its dotted path (`''` is the input itself) and what to put there. */
export interface DrawnBinding {
  readonly path: string;
  readonly placeholder: string;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** `@ultimat3/schema/sample`'s name for a gap at the root (`ROOT_PATH`): a bare `t.string` input. */
const SAMPLE_ROOT = '(the input)';

/**
 * One `sampleGaps` path, as a binding: `describeSampleGap`'s answer (`digest (must match …)`)
 * minus the path is what the placeholder asks for. Taken as two strings, so this tier never loads
 * the sampler: the caller already has it.
 */
export function sampleGapBinding(path: string, described: string): DrawnBinding {
  const need = described.startsWith(path) ? described.slice(path.length).trim() : '';
  const asked = /^\((.*)\)$/.exec(need)?.[1] ?? 'a value its schema accepts';
  return { path: path === SAMPLE_ROOT ? '' : path, placeholder: `<${asked}>` };
}

/** A property key as source: bare when it is an identifier, a JSON string otherwise. */
export const renderExerciseKey = (key: string): string =>
  IDENTIFIER.test(key) ? key : JSON.stringify(key);

interface Tree {
  readonly leaves: Map<string, string | Tree>;
}

const placeholderOf = (text: string): string => renderFixLiteral(text, '"<a value>"');

function insert(tree: Tree, parts: readonly string[], placeholder: string): void {
  const [head, ...rest] = parts;
  if (head === undefined) return;
  if (rest.length === 0) {
    tree.leaves.set(head, placeholder);
    return;
  }
  const existing = tree.leaves.get(head);
  const child = typeof existing === 'object' ? existing : { leaves: new Map() };
  tree.leaves.set(head, child);
  insert(child, rest, placeholder);
}

/** `drawn.a`, then `(drawn.a as Record<string, unknown>).b`: each step typechecks as pasted. */
const member = (access: string, key: string): string => {
  const on = access === 'drawn' ? access : `(${access} as Record<string, unknown>)`;
  return IDENTIFIER.test(key) ? `${on}.${key}` : `${on}[${JSON.stringify(key)}]`;
};

function renderTree(tree: Tree, access: string): string {
  const spread = access === 'drawn' ? '...drawn' : `...(${access} as object)`;
  const fields = [...tree.leaves].map(([key, value]) => {
    const rendered =
      typeof value === 'string' ? placeholderOf(value) : renderTree(value, member(access, key));
    return `, ${renderExerciseKey(key)}: ${rendered}`;
  });
  return `{ ${spread}${fields.join('')} }`;
}

/**
 * `(drawn) => ({ ...drawn, digest: "<must match ^[0-9a-f]{64}$>" })`. A nested path keeps its
 * parent's draw (`a: { ...(drawn.a as object), b: … }`); a gap at the root (`''`) replaces it.
 */
export function renderDrawnInput(bindings: readonly DrawnBinding[]): string {
  const root = bindings.find((binding) => binding.path === '');
  if (root !== undefined) return `() => ${placeholderOf(root.placeholder)}`;
  const tree: Tree = { leaves: new Map() };
  for (const binding of bindings) insert(tree, binding.path.split('.'), binding.placeholder);
  return `(drawn) => (${renderTree(tree, 'drawn')})`;
}
