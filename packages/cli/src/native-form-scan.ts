// Which action a page's `<form method="post">` posts to, read from the page's SOURCE: a literal
// path, `derivePath(name).path`, `actionHttpPath(name, …).path`, or a same-file `const` holding one
// of those. Pure text in, targets out — `verify-native-form.ts` matches them to registered actions.

/** A form's target: an action named outright, or a URL path to match against the routes. */
export type FormTarget =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'path'; readonly value: string };

export interface PostForm {
  readonly line: number;
  readonly target: FormTarget;
}

/** How many `const` hops a value is followed through; a page that needs more is not read. */
const MAX_HOPS = 3;

const PATH_CALL = /^(?:derivePath|actionHttpPath)\(\s*([^,)]+?)\s*[,)]/;
const STRING = /^(['"])([^'"`]*)\1/;

/** The text up to the `>` that closes this tag, quotes and `{…}` skipped whole; `undefined` if open. */
function openingTag(source: string, from: number): string | undefined {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return source.slice(from, i);
  }
  return undefined;
}

/** An attribute's raw value: a quoted string's text, or a `{…}` expression's, balanced. */
function attribute(tag: string, name: string): { quoted: boolean; text: string } | undefined {
  const at = new RegExp(`\\s${name}\\s*=\\s*`).exec(tag);
  if (at === null) return undefined;
  const start = at.index + at[0].length;
  const open = tag[start];
  if (open === '"' || open === "'") {
    const end = tag.indexOf(open, start + 1);
    return end === -1 ? undefined : { quoted: true, text: tag.slice(start + 1, end) };
  }
  if (open !== '{') return undefined;
  let depth = 0;
  for (let i = start; i < tag.length; i++) {
    if (tag[i] === '{') depth++;
    else if (tag[i] === '}' && --depth === 0)
      return { quoted: false, text: tag.slice(start + 1, i) };
  }
  return undefined;
}

/** `const NAME = <expr>;` in this file, or `undefined`. */
function constValue(source: string, name: string): string | undefined {
  const match = new RegExp(`\\bconst\\s+${name}\\s*=\\s*([^;]+);`).exec(source);
  return match?.[1]?.trim();
}

/** A string an expression evaluates to — a literal (`satisfies` ignored) or a const holding one. */
function stringOf(source: string, expression: string, hops: number): string | undefined {
  const text = expression.trim();
  const literal = STRING.exec(text);
  if (literal !== null) return literal[2];
  if (hops >= MAX_HOPS || !/^[A-Za-z_$][\w$]*$/.test(text)) return undefined;
  const held = constValue(source, text);
  return held === undefined ? undefined : stringOf(source, held, hops + 1);
}

/** What an `action={…}` expression names, followed through same-file consts. */
export function targetOf(source: string, expression: string, hops = 0): FormTarget | undefined {
  const text = expression.trim();
  const call = PATH_CALL.exec(text);
  if (call !== null) {
    const name = stringOf(source, call[1] ?? '', 0);
    return name === undefined ? undefined : { kind: 'name', value: name };
  }
  const literal = STRING.exec(text);
  if (literal !== null) {
    const value = literal[2] ?? '';
    return value.startsWith('/') ? { kind: 'path', value } : undefined;
  }
  if (hops >= MAX_HOPS || !/^[A-Za-z_$][\w$]*$/.test(text)) return undefined;
  const held = constValue(source, text);
  return held === undefined ? undefined : targetOf(source, held, hops + 1);
}

/** Every `<form method="post" action=…>` in a page whose target can be read. */
export function postForms(source: string): readonly PostForm[] {
  const forms: PostForm[] = [];
  for (const match of source.matchAll(/<form\b/g)) {
    const tag = openingTag(source, match.index);
    if (tag === undefined) continue;
    const method = attribute(tag, 'method');
    const verb = method?.quoted === true ? method.text : stringOf(source, method?.text ?? '', 0);
    if (verb?.toLowerCase() !== 'post') continue;
    const action = attribute(tag, 'action');
    if (action === undefined) continue;
    const target = action.quoted
      ? action.text.startsWith('/')
        ? ({ kind: 'path', value: action.text } as const)
        : undefined
      : targetOf(source, action.text);
    if (target === undefined) continue;
    forms.push({ line: source.slice(0, match.index).split('\n').length, target });
  }
  return forms;
}

/** Does a route path (`/orders/:id/refund`) answer this URL path? Query and fragment ignored. */
export function pathMatches(route: string, path: string): boolean {
  const want = route.split('/');
  const got = (path.split(/[?#]/)[0] ?? '').split('/');
  if (want.length !== got.length) return false;
  return want.every((segment, i) => segment.startsWith(':') || segment === got[i]);
}
