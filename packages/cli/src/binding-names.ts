// The names an object destructuring BINDS, read off masked source: `{ fetch: f }` binds `f`, never
// `fetch`; `{ fetch }`, `{ fetch = d }`, `{ a: { fetch } }` and `{ ...fetch }` bind `fetch`. Only a
// pattern in a binding position counts — a `const`/`let`/`var` declaration or a parameter list —
// so `make({ fetch })`, the very hand-off the transport rule reports, binds nothing.

/** Opening bracket → its closer. A `Map`: a char read off source never reaches a prototype. */
const PAIRS: ReadonlyMap<string, string> = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);

/** The index of the bracket closing the one at `open`, or `-1`. Exact on masked text only. */
function closing(masked: string, open: number): number {
  const stack: string[] = [];
  for (let at = open; at < masked.length; at += 1) {
    const char = masked[at] ?? '';
    const close = PAIRS.get(char);
    if (close !== undefined) stack.push(close);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return at;
    }
  }
  return -1;
}

/** The index of the unmatched `(` enclosing `index`, or `-1`. */
function enclosingParen(masked: string, index: number): number {
  let depth = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    const char = masked[at] ?? '';
    if (char === ')' || char === ']' || char === '}') depth += 1;
    else if (char === '(' || char === '[' || char === '{') {
      if (depth === 0) return char === '(' ? at : -1;
      depth -= 1;
    }
  }
  return -1;
}

/** `text` split on commas at depth zero — a pattern's entries. */
function topLevel(text: string, separator: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? '';
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(from, at));
      from = at + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/** The first `=` at depth zero that is no `==`/`=>`, or `-1`: where a default starts. */
function defaultAt(text: string): number {
  let depth = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? '';
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === '=' && depth === 0 && !/[=>]/.test(text[at + 1] ?? '')) {
      return /[=!<>]/.test(text[at - 1] ?? '') ? -1 : at;
    }
  }
  return -1;
}

/** The names one binding target binds: an identifier, or a nested object or array pattern. */
function targetNames(raw: string): readonly string[] {
  const cut = defaultAt(raw);
  const target = (cut < 0 ? raw : raw.slice(0, cut))
    .trim()
    .replace(/^\.\.\./, '')
    .trim();
  if (target.startsWith('{')) return patternNames(target.slice(1, -1), 'object');
  if (target.startsWith('[')) return patternNames(target.slice(1, -1), 'array');
  const name = /^[\w$]+/.exec(target)?.[0];
  return name === undefined ? [] : [name];
}

function patternNames(body: string, kind: 'object' | 'array'): readonly string[] {
  return topLevel(body, ',').flatMap((entry) => {
    if (kind === 'array') return targetNames(entry);
    const [key, ...rest] = topLevel(entry, ':');
    // `key: target` binds the target; a shorthand `name` or `name = d` binds the name.
    return rest.length === 0 ? targetNames(key ?? '') : targetNames(rest.join(':'));
  });
}

/** Cheap, before any bracket is matched: a declaration keyword, or a `(`/`,` a parameter follows. */
function mayBind(masked: string, open: number): 'declared' | 'parameter' | undefined {
  const head = masked.slice(Math.max(0, open - 8), open);
  if (/\b(?:const|let|var)\s*$/.test(head)) return 'declared';
  return /[(,]\s*$/.test(masked.slice(Math.max(0, open - 64), open)) ? 'parameter' : undefined;
}

/** A `{` after `(`/`,` is a parameter when its list is followed by a body, an arrow or a type. */
function isParameter(masked: string, open: number, close: number): boolean {
  const paren = enclosingParen(masked, open);
  if (paren < 0) return false;
  const end = closing(masked, paren);
  if (end < close) return false;
  // A call's arguments are followed by neither: `make({ fetch }).then(go)`, `make({ fetch });`.
  return /^\s*(?:=>|\{|:(?!:))/.test(masked.slice(end + 1, end + 64));
}

/** Every name the object patterns in binding positions of `masked` bind. */
export function destructuredNames(masked: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (let open = masked.indexOf('{'); open >= 0; open = masked.indexOf('{', open + 1)) {
    const position = mayBind(masked, open);
    if (position === undefined) continue;
    const close = closing(masked, open);
    if (close < 0 || (position === 'parameter' && !isParameter(masked, open, close))) continue;
    for (const name of patternNames(masked.slice(open + 1, close), 'object')) names.add(name);
  }
  return names;
}
